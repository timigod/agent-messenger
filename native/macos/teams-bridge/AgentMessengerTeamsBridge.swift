import AppKit
import CommonCrypto
import Darwin
import Foundation
import Security
import SQLite3

private let bridgeLabel = "com.timiaji.agent-messenger-teams-bridge"
private let clientRequirement =
    "anchor apple generic and identifier \"com.timiaji.agent-messenger-teams-bridge-client\" and certificate leaf[subject.OU] = \"9F4ARQ5FJR\""

@objc private protocol TeamsBridgeXPCProtocol {
    func run(_ requestData: Data, withReply reply: @escaping (Data) -> Void)
}

private struct BridgeRequest: Codable {
    let version: Int
    let id: String
    let args: [String]
    let profile: String?
    let timeout_ms: Int?
    let input_files: [BridgeInputFile]?
    let output_files: [BridgeOutputFileRequest]?
}

private struct BridgeInputFile: Codable {
    let argument_index: Int
    let filename: String
    let bytes: Data
}

private struct BridgeOutputFileRequest: Codable {
    let argument_index: Int
    let filename: String
}

private struct BridgeOutputFile: Codable {
    let argument_index: Int
    let filename: String
    let bytes: Data
}

private struct BridgeResponse: Codable {
    let version: Int
    let id: String
    let exit_code: Int32
    let stdout: String
    let stderr: String
    let output_files: [BridgeOutputFile]?
}

private enum ApprovedFileCommand {
    case input(argumentIndex: Int)
    case output(argumentIndex: Int)
}

private func bridgePositionals(_ args: [String]) throws -> [(index: Int, value: String)] {
    var positionals: [(index: Int, value: String)] = []
    var optionsEnded = false
    var index = 0
    while index < args.count {
        let value = args[index]
        if !optionsEnded, value == "--" {
            optionsEnded = true
            index += 1
            continue
        }
        if !optionsEnded, value == "--pretty" {
            index += 1
            continue
        }
        if !optionsEnded, value == "--account" || value == "--team" {
            guard index + 1 < args.count else {
                throw BridgeError.invalidRequest("Teams bridge command has an option without a value.")
            }
            index += 2
            continue
        }
        if !optionsEnded, value.hasPrefix("--account=") || value.hasPrefix("--team=") {
            guard value.last != "=" else {
                throw BridgeError.invalidRequest("Teams bridge command has an empty option value.")
            }
            index += 1
            continue
        }
        positionals.append((index, value))
        index += 1
    }
    return positionals
}

private func approvedFileCommand(_ args: [String]) throws -> ApprovedFileCommand? {
    let positionals = try bridgePositionals(args)
    guard positionals.count >= 2 else { return nil }
    let command = positionals[0].value
    let action = positionals[1].value
    switch (command, action) {
    case ("file", "upload"):
        guard positionals.count == 5 else {
            throw BridgeError.invalidRequest("Use: agent-teams file upload <team-id> <channel-id> <path> [--pretty].")
        }
        return .input(argumentIndex: positionals[4].index)
    case ("file", "download"):
        guard positionals.count == 6 else {
            throw BridgeError.invalidRequest("Teams bridge file downloads require one staged output path.")
        }
        return .output(argumentIndex: positionals[5].index)
    case ("chat", "download-image"):
        guard positionals.count == 4 else {
            throw BridgeError.invalidRequest("Teams bridge image downloads require one staged output path.")
        }
        return .output(argumentIndex: positionals[3].index)
    default:
        return nil
    }
}

private func stagedFileArgs(
    _ args: [String],
    request: BridgeRequest,
    stagedRoot: URL
) throws -> ([String], [BridgeOutputFileRequest]) {
    let inputs = request.input_files ?? []
    let outputs = request.output_files ?? []
    var rewritten = args

    switch try approvedFileCommand(args) {
    case .input(let argumentIndex):
        guard inputs.count == 1, outputs.isEmpty else {
            throw BridgeError.invalidRequest("Teams bridge upload commands require exactly one input file declaration.")
        }
        let input = inputs[0]
        guard input.argument_index == argumentIndex, argumentIndex < args.count,
              input.bytes.count <= 20 * 1_024 * 1_024,
              args[argumentIndex] == input.filename,
              !input.filename.isEmpty,
              input.filename == URL(fileURLWithPath: input.filename).lastPathComponent else {
            throw BridgeError.invalidRequest("Teams bridge input file does not match the approved upload command.")
        }
        let inputRoot = stagedRoot.appendingPathComponent("input", isDirectory: true)
        let stagedFile = inputRoot.appendingPathComponent(input.filename, isDirectory: false)
        try writePrivate(input.bytes, to: stagedFile)
        rewritten[argumentIndex] = stagedFile.path
        return (rewritten, [])
    case .output(let argumentIndex):
        guard inputs.isEmpty, outputs.count == 1 else {
            throw BridgeError.invalidRequest("Teams bridge download commands require exactly one output file declaration.")
        }
        let output = outputs[0]
        guard output.argument_index == argumentIndex, argumentIndex < args.count,
              args[argumentIndex] == output.filename,
              !output.filename.isEmpty,
              output.filename == URL(fileURLWithPath: output.filename).lastPathComponent else {
            throw BridgeError.invalidRequest("Teams bridge output file does not match the approved download command.")
        }
        let outputRoot = stagedRoot.appendingPathComponent("output", isDirectory: true)
        try ensureDirectory(outputRoot)
        rewritten[argumentIndex] = outputRoot.appendingPathComponent(output.filename, isDirectory: false).path
        return (rewritten, outputs)
    case nil:
        guard inputs.isEmpty, outputs.isEmpty else {
            throw BridgeError.invalidRequest("Teams bridge file declarations are not allowed for this command.")
        }
        return (rewritten, [])
    }
}

private func collectOutputFiles(_ requests: [BridgeOutputFileRequest], stagedRoot: URL) throws -> [BridgeOutputFile]? {
    guard !requests.isEmpty else { return nil }
    let outputRoot = stagedRoot.appendingPathComponent("output", isDirectory: true)
    let outputRootDescriptor = open(outputRoot.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    guard outputRootDescriptor >= 0 else {
        throw BridgeError.runtimeFailed("Teams bridge output directory is unavailable.")
    }
    defer { close(outputRootDescriptor) }
    return try requests.map { request in
        guard !request.filename.isEmpty,
              request.filename == URL(fileURLWithPath: request.filename).lastPathComponent else {
            throw BridgeError.runtimeFailed("Teams bridge output has an invalid name.")
        }
        let fileDescriptor = openat(outputRootDescriptor, request.filename, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard fileDescriptor >= 0 else {
            throw BridgeError.runtimeFailed("Teams bridge output is missing or exceeds 20 MiB.")
        }
        defer { close(fileDescriptor) }
        var status = stat()
        guard fstat(fileDescriptor, &status) == 0,
              status.st_mode & S_IFMT == S_IFREG,
              status.st_size >= 0,
              status.st_size <= 20 * 1_024 * 1_024 else {
            throw BridgeError.runtimeFailed("Teams bridge output is missing or exceeds 20 MiB.")
        }
        var bytes = Data()
        bytes.reserveCapacity(Int(status.st_size))
        var chunk = [UInt8](repeating: 0, count: 64 * 1_024)
        while true {
            let count = chunk.withUnsafeMutableBytes { rawBuffer in
                Darwin.read(fileDescriptor, rawBuffer.baseAddress, rawBuffer.count)
            }
            if count < 0, errno == EINTR { continue }
            guard count >= 0, bytes.count + count <= 20 * 1_024 * 1_024 else {
                throw BridgeError.runtimeFailed("Teams bridge output is missing or exceeds 20 MiB.")
            }
            if count == 0 { break }
            bytes.append(contentsOf: chunk.prefix(count))
        }
        return BridgeOutputFile(
            argument_index: request.argument_index,
            filename: request.filename,
            bytes: bytes
        )
    }
}

private enum BridgeError: LocalizedError {
    case invalidRequest(String)
    case setupRequired(String)
    case stagingFailed(String)
    case runtimeFailed(String)

    var errorDescription: String? {
        switch self {
        case .invalidRequest(let message), .setupRequired(let message), .stagingFailed(let message),
             .runtimeFailed(let message):
            return message
        }
    }
}

private final class BridgePaths {
    let support: URL
    let caches: URL
    let bookmark: URL
    let staging: URL
    let liveConfig: URL
    let proofConfig: URL

    init() {
        let applicationSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let cachesDirectory = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        support = applicationSupport.appendingPathComponent("Agent Messenger Teams Bridge", isDirectory: true)
        caches = cachesDirectory.appendingPathComponent("Agent Messenger Teams Bridge", isDirectory: true)
        bookmark = support.appendingPathComponent("teams-ebwebview.bookmark")
        staging = caches.appendingPathComponent("staging", isDirectory: true)
        liveConfig = support.appendingPathComponent("live", isDirectory: true)
        proofConfig = support.appendingPathComponent("proof", isDirectory: true)
    }

    func prepare() throws {
        for directory in [support, caches, staging, liveConfig, proofConfig] {
            try ensureDirectory(directory)
        }
        for abandoned in try FileManager.default.contentsOfDirectory(at: staging, includingPropertiesForKeys: nil) {
            try? FileManager.default.removeItem(at: abandoned)
        }
    }
}

private func ensureDirectory(_ url: URL) throws {
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    guard chmod(url.path, mode_t(0o700)) == 0 else { throw POSIXError(.EACCES) }
}

private func writePrivate(_ data: Data, to url: URL) throws {
    try ensureDirectory(url.deletingLastPathComponent())
    let temporary = url.deletingLastPathComponent().appendingPathComponent(".\(url.lastPathComponent).\(UUID().uuidString)")
    try data.write(to: temporary, options: .atomic)
    guard chmod(temporary.path, mode_t(0o600)) == 0 else {
        try? FileManager.default.removeItem(at: temporary)
        throw POSIXError(.EACCES)
    }
    try? FileManager.default.removeItem(at: url)
    try FileManager.default.moveItem(at: temporary, to: url)
}

private func actualHomeDirectory() throws -> URL {
    guard let passwordEntry = getpwuid(getuid()), let path = passwordEntry.pointee.pw_dir else {
        throw BridgeError.setupRequired("Unable to resolve the signed-in user's home directory.")
    }
    return URL(fileURLWithPath: String(cString: path), isDirectory: true)
}

private func isSafeIdentifier(_ value: String) -> Bool {
    guard !value.isEmpty, value.count <= 64 else { return false }
    return value.unicodeScalars.allSatisfy {
        CharacterSet.alphanumerics.contains($0) || $0 == "-" || $0 == "_"
    }
}

private func validatedArgs(_ request: BridgeRequest) throws -> [String] {
    guard request.version == 1, isSafeIdentifier(request.id) else {
        throw BridgeError.invalidRequest("Invalid Teams bridge request identity.")
    }
    guard !request.args.isEmpty, request.args.count <= 64 else {
        throw BridgeError.invalidRequest("Invalid Teams bridge argument count.")
    }
    guard request.args.allSatisfy({ $0.utf8.count <= 16_384 && !$0.contains("\0") }) else {
        throw BridgeError.invalidRequest("Invalid Teams bridge argument payload.")
    }
    let positionals = try bridgePositionals(request.args)
    let command = positionals.first?.value
    let action = positionals.dropFirst().first?.value
    if command == "auth", action == "login" {
        throw BridgeError.invalidRequest("Teams device-code login is disabled; the official desktop app owns sign-in.")
    }
    if request.args.contains("--token") || request.args.contains(where: { $0.hasPrefix("--token=") }) {
        throw BridgeError.invalidRequest("Manual Teams token input is disabled.")
    }
    if request.args.contains("--browser-profile") || request.args.contains(where: { $0.hasPrefix("--browser-profile=") }) {
        throw BridgeError.invalidRequest("Browser-profile Teams extraction is disabled.")
    }

    var args = request.args
    if command == "auth", action == "extract" {
        var sourceWasProvided = false
        var index = 0
        while index < args.count {
            let value = args[index]
            if value == "--" { break }
            if value == "--source" {
                guard index + 1 < args.count, args[index + 1] == "desktop" else {
                    throw BridgeError.invalidRequest("Only the desktop Teams authentication source is allowed.")
                }
                sourceWasProvided = true
                index += 2
                continue
            }
            if value.hasPrefix("--source=") {
                guard value == "--source=desktop" else {
                    throw BridgeError.invalidRequest("Only the desktop Teams authentication source is allowed.")
                }
                sourceWasProvided = true
            }
            index += 1
        }
        if !sourceWasProvided {
            args.append(contentsOf: ["--source", "desktop"])
        }
    }
    return args
}

private func selectedConfigDirectory(for request: BridgeRequest, paths: BridgePaths) throws -> URL {
    switch request.profile ?? "live" {
    case "live": return paths.liveConfig
    case "proof": return paths.proofConfig
    default: throw BridgeError.invalidRequest("Unknown Teams bridge profile.")
    }
}

private final class TeamsSourceAccess {
    private let paths: BridgePaths
    private var activeURL: URL?
    private var startedSecurityScope = false

    init(paths: BridgePaths) {
        self.paths = paths
    }

    deinit {
        if startedSecurityScope { activeURL?.stopAccessingSecurityScopedResource() }
    }

    func resolveExisting() -> URL? {
        if let activeURL { return activeURL }
        guard FileManager.default.fileExists(atPath: paths.bookmark.path) else { return nil }
        do {
            let data = try Data(contentsOf: paths.bookmark)
            var stale = false
            let url = try URL(
                resolvingBookmarkData: data,
                options: [.withSecurityScope, .withoutUI],
                relativeTo: nil,
                bookmarkDataIsStale: &stale
            )
            let started = url.startAccessingSecurityScopedResource()
            try validate(url)
            if stale { try persistBookmark(for: url) }
            activeURL = url
            startedSecurityScope = started
            return url
        } catch {
            return nil
        }
    }

    @MainActor
    func resolveOrRequest() throws -> URL {
        if let activeURL { return activeURL }
        if let existing = resolveExisting() { return existing }

        NSApp.activate(ignoringOtherApps: true)
        let panel = NSOpenPanel()
        panel.title = "Allow Agent Messenger to use your Teams desktop sessions"
        panel.message = "Select the EBWebView folder. The companion receives read-only access to the two sessions already signed in inside Microsoft Teams."
        panel.prompt = "Grant Access"
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = false
        panel.resolvesAliases = true
        panel.directoryURL = try actualHomeDirectory().appendingPathComponent(
            "Library/Containers/com.microsoft.teams2/Data/Library/Application Support/Microsoft/MSTeams/EBWebView",
            isDirectory: true
        )
        guard panel.runModal() == .OK, let url = panel.url else {
            throw BridgeError.setupRequired("Teams desktop access was not granted.")
        }
        try validate(url)
        try persistBookmark(for: url)
        startedSecurityScope = url.startAccessingSecurityScopedResource()
        activeURL = url
        return url
    }

    private func validate(_ url: URL) throws {
        guard url.lastPathComponent == "EBWebView" else {
            throw BridgeError.setupRequired("Select Microsoft Teams' EBWebView folder, not a broader folder.")
        }
        _ = try FileManager.default.contentsOfDirectory(at: url, includingPropertiesForKeys: nil)
    }

    private func persistBookmark(for url: URL) throws {
        let data = try url.bookmarkData(
            options: [.withSecurityScope],
            includingResourceValuesForKeys: nil,
            relativeTo: nil
        )
        try writePrivate(data, to: paths.bookmark)
    }
}

private let keychainVariants = [
    ("Microsoft Teams Safe Storage", "Microsoft Teams"),
    ("Microsoft Teams (work or school) Safe Storage", "Microsoft Teams (work or school)"),
    ("Teams Safe Storage", "Teams"),
]

private func deriveTeamsKey(from passwordData: Data) throws -> Data {
    let password = String(decoding: passwordData, as: UTF8.self)
    let salt = Array("saltysalt".utf8)
    var derived = [UInt8](repeating: 0, count: 16)
    let result = password.withCString { passwordPointer in
        salt.withUnsafeBytes { saltBytes in
            CCKeyDerivationPBKDF(
                CCPBKDFAlgorithm(kCCPBKDF2),
                passwordPointer,
                password.utf8.count,
                saltBytes.bindMemory(to: UInt8.self).baseAddress,
                salt.count,
                CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA1),
                1003,
                &derived,
                derived.count
            )
        }
    }
    guard result == kCCSuccess else {
        throw BridgeError.runtimeFailed("Unable to derive the Teams desktop decryption key.")
    }
    return Data(derived)
}

private func ensureDerivedTeamsKey(configDirectory: URL, forceRefresh: Bool = false) throws {
    let keyPath = configDirectory.appendingPathComponent(".derived-keys/teams.key")
    if !forceRefresh, let existing = try? Data(contentsOf: keyPath), existing.count == 16 { return }
    if forceRefresh { try? FileManager.default.removeItem(at: keyPath) }

    for (service, account) in keychainVariants {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { continue }
        guard status == errSecSuccess, let passwordData = item as? Data else {
            throw BridgeError.setupRequired("Microsoft Teams Safe Storage access was not granted (Keychain status \(status)).")
        }
        try writePrivate(try deriveTeamsKey(from: passwordData), to: keyPath)
        return
    }
    throw BridgeError.setupRequired("Microsoft Teams Safe Storage was not found in Keychain.")
}

private func snapshotSQLiteDatabase(_ source: URL, to destination: URL) throws {
    try ensureDirectory(destination.deletingLastPathComponent())
    try? FileManager.default.removeItem(at: destination)

    do {
        var sourceHandle: OpaquePointer?
        var destinationHandle: OpaquePointer?
        guard sqlite3_open_v2(source.path, &sourceHandle, SQLITE_OPEN_READONLY | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK,
              let sourceDatabase = sourceHandle else {
            if let sourceHandle { sqlite3_close(sourceHandle) }
            throw BridgeError.stagingFailed("Unable to open Teams' live cookie database read-only.")
        }
        defer { if let sourceHandle { sqlite3_close(sourceHandle) } }
        guard sqlite3_open_v2(
            destination.path,
            &destinationHandle,
            SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX,
            nil
        ) == SQLITE_OK, let destinationDatabase = destinationHandle else {
            if let destinationHandle { sqlite3_close(destinationHandle) }
            throw BridgeError.stagingFailed("Unable to create the private Teams cookie snapshot.")
        }
        defer { if let destinationHandle { sqlite3_close(destinationHandle) } }
        sqlite3_busy_timeout(sourceDatabase, 2_000)
        sqlite3_busy_timeout(destinationDatabase, 2_000)

        guard let backup = sqlite3_backup_init(destinationDatabase, "main", sourceDatabase, "main") else {
            throw BridgeError.stagingFailed("Unable to start a consistent Teams cookie snapshot.")
        }
        var result = SQLITE_OK
        var contentionRetries = 0
        repeat {
            result = sqlite3_backup_step(backup, 64)
            if result == SQLITE_BUSY || result == SQLITE_LOCKED {
                contentionRetries += 1
                if contentionRetries > 80 { break }
                sqlite3_sleep(25)
            }
        } while result == SQLITE_OK || result == SQLITE_BUSY || result == SQLITE_LOCKED
        let finishResult = sqlite3_backup_finish(backup)
        guard result == SQLITE_DONE, finishResult == SQLITE_OK else {
            throw BridgeError.stagingFailed("Teams' cookie database stayed busy; no inconsistent snapshot was used.")
        }
        guard sqlite3_exec(destinationDatabase, "PRAGMA journal_mode=DELETE", nil, nil, nil) == SQLITE_OK else {
            throw BridgeError.stagingFailed("Unable to finalize the private Teams cookie snapshot.")
        }
        guard sqlite3_close(destinationDatabase) == SQLITE_OK else {
            throw BridgeError.stagingFailed("Unable to close the private Teams cookie snapshot.")
        }
        destinationHandle = nil
        guard sqlite3_close(sourceDatabase) == SQLITE_OK else {
            throw BridgeError.stagingFailed("Unable to close Teams' live cookie database snapshot.")
        }
        sourceHandle = nil
    }
    for suffix in ["-wal", "-shm"] {
        let sidecar = URL(fileURLWithPath: destination.path + suffix)
        if FileManager.default.fileExists(atPath: sidecar.path) {
            do {
                try FileManager.default.removeItem(at: sidecar)
            } catch {
                throw BridgeError.stagingFailed("Unable to remove a private Teams cookie snapshot sidecar.")
            }
        }
    }
    guard chmod(destination.path, mode_t(0o600)) == 0 else { throw POSIXError(.EACCES) }
}

private let teamsProfileDatabaseLayout: [(profile: String, required: Bool)] = [
    ("WV2Profile_tfw", true),
    ("WV2Profile_tfl", true),
    ("Default", false),
]

private let teamsCookieDatabasePaths = ["Cookies", "Network/Cookies"]

private func snapshotTeamsProfileDatabases(sourceRoot: URL, destinationRoot: URL) throws {
    for entry in teamsProfileDatabaseLayout {
        var snapshotCount = 0
        for relativePath in teamsCookieDatabasePaths {
            let source = sourceRoot
                .appendingPathComponent(entry.profile, isDirectory: true)
                .appendingPathComponent(relativePath, isDirectory: false)
            guard FileManager.default.fileExists(atPath: source.path) else { continue }
            let destination = destinationRoot
                .appendingPathComponent(entry.profile, isDirectory: true)
                .appendingPathComponent(relativePath, isDirectory: false)
            try snapshotSQLiteDatabase(source, to: destination)
            snapshotCount += 1
        }
        if entry.required, snapshotCount == 0 {
            throw BridgeError.stagingFailed("No cookie database found for Teams profile \(entry.profile).")
        }
    }
}

private func stageTeamsProfiles(sourceRoot: URL, paths: BridgePaths, requestID: String) throws -> URL {
    let destinationRoot = paths.staging.appendingPathComponent(requestID, isDirectory: true)
    try? FileManager.default.removeItem(at: destinationRoot)
    try ensureDirectory(destinationRoot)
    do {
        try snapshotTeamsProfileDatabases(sourceRoot: sourceRoot, destinationRoot: destinationRoot)
        let localState = sourceRoot.appendingPathComponent("Local State")
        if FileManager.default.fileExists(atPath: localState.path) {
            try writePrivate(try Data(contentsOf: localState), to: destinationRoot.appendingPathComponent("Local State"))
        }
        return destinationRoot
    } catch {
        try? FileManager.default.removeItem(at: destinationRoot)
        throw error
    }
}

private func runAgentTeams(
    args: [String],
    configDirectory: URL,
    stagedRoot: URL,
    timeoutMilliseconds: Int
) throws -> (Int32, String, String) {
    guard let resources = Bundle.main.resourceURL else {
        throw BridgeError.runtimeFailed("Teams bridge resources are unavailable.")
    }
    let bun = resources.appendingPathComponent("runtime/bun")
    let launcher = resources.appendingPathComponent("runtime/launcher")
    let agentRoot = resources.appendingPathComponent("agent-messenger", isDirectory: true)
    let cli = agentRoot.appendingPathComponent("dist/src/platforms/teams/cli.js")
    guard FileManager.default.isExecutableFile(atPath: bun.path),
          FileManager.default.isExecutableFile(atPath: launcher.path),
          FileManager.default.fileExists(atPath: cli.path) else {
        throw BridgeError.runtimeFailed("The embedded Agent Messenger runtime is incomplete.")
    }

    let process = Process()
    process.executableURL = launcher
    process.arguments = [bun.path, cli.path] + args
    process.currentDirectoryURL = agentRoot
    process.environment = [
        "HOME": configDirectory.path,
        "TMPDIR": NSTemporaryDirectory(),
        "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
        "LANG": "en_GB.UTF-8",
        "LC_ALL": "en_GB.UTF-8",
        "NO_COLOR": "1",
        "AGENT_MESSENGER_CONFIG_DIR": configDirectory.path,
        "AGENT_TEAMS_AUTH_SOURCE": "desktop",
        "AGENT_TEAMS_DESKTOP_PROFILE_ROOT": stagedRoot.path,
        "AGENT_TEAMS_DISABLE_KEYCHAIN_LOOKUP": "1",
    ]

    let outputPipe = Pipe()
    let errorPipe = Pipe()
    process.standardOutput = outputPipe
    process.standardError = errorPipe
    try process.run()

    let readGroup = DispatchGroup()
    let lock = NSLock()
    var stdoutData = Data()
    var stderrData = Data()
    var outputExceeded = false
    let outputLimit = 4 * 1_024 * 1_024
    let processGroup = process.processIdentifier
    func collect(_ handle: FileHandle, intoStdout: Bool) {
        readGroup.enter()
        DispatchQueue.global(qos: .utility).async {
            defer { readGroup.leave() }
            while let chunk = try? handle.read(upToCount: 64 * 1_024), !chunk.isEmpty {
                lock.lock()
                if stdoutData.count + stderrData.count + chunk.count > outputLimit {
                    outputExceeded = true
                    lock.unlock()
                    kill(-processGroup, SIGKILL)
                    break
                }
                if intoStdout { stdoutData.append(chunk) } else { stderrData.append(chunk) }
                lock.unlock()
            }
        }
    }
    collect(outputPipe.fileHandleForReading, intoStdout: true)
    collect(errorPipe.fileHandleForReading, intoStdout: false)

    let completion = DispatchSemaphore(value: 0)
    DispatchQueue.global(qos: .userInitiated).async { process.waitUntilExit(); completion.signal() }
    let boundedTimeout = min(max(timeoutMilliseconds, 5_000), 120_000)
    if completion.wait(timeout: .now() + .milliseconds(boundedTimeout)) == .timedOut {
        kill(-processGroup, SIGTERM)
        if completion.wait(timeout: .now() + .seconds(2)) == .timedOut {
            kill(-processGroup, SIGKILL)
            _ = completion.wait(timeout: .now() + .seconds(5))
        }
        _ = readGroup.wait(timeout: .now() + .seconds(2))
        return (124, String(data: stdoutData, encoding: .utf8) ?? "", "Teams bridge request timed out.\n")
    }
    _ = readGroup.wait(timeout: .now() + .seconds(2))
    guard !outputExceeded else {
        throw BridgeError.runtimeFailed("Teams bridge response exceeded the 4 MiB safety limit.")
    }
    return (
        process.terminationStatus,
        String(data: stdoutData, encoding: .utf8) ?? "",
        String(data: stderrData, encoding: .utf8) ?? ""
    )
}

private final class TeamsBridgeService: NSObject, TeamsBridgeXPCProtocol {
    private let paths: BridgePaths
    private let sourceAccess: TeamsSourceAccess
    private let queue = DispatchQueue(label: "com.timiaji.agent-messenger-teams-bridge.requests")

    init(paths: BridgePaths, sourceAccess: TeamsSourceAccess) {
        self.paths = paths
        self.sourceAccess = sourceAccess
    }

    func run(_ requestData: Data, withReply reply: @escaping (Data) -> Void) {
        queue.async {
            let response: BridgeResponse
            var responseID = "invalid"
            var stagedRoot: URL?
            do {
                guard requestData.count <= 28 * 1_024 * 1_024 else {
                    throw BridgeError.invalidRequest("Teams bridge request exceeded the 28 MiB safety limit.")
                }
                let request = try JSONDecoder().decode(BridgeRequest.self, from: requestData)
                responseID = request.id
                let args = try validatedArgs(request)
                let config = try selectedConfigDirectory(for: request, paths: self.paths)
                let sourceRoot: URL
                if let existing = self.sourceAccess.resolveExisting() {
                    sourceRoot = existing
                } else {
                    sourceRoot = try DispatchQueue.main.sync {
                        try MainActor.assumeIsolated { try self.sourceAccess.resolveOrRequest() }
                    }
                }
                try ensureDerivedTeamsKey(configDirectory: config)
                let stage = try stageTeamsProfiles(sourceRoot: sourceRoot, paths: self.paths, requestID: request.id)
                stagedRoot = stage
                let (runtimeArgs, outputRequests) = try stagedFileArgs(args, request: request, stagedRoot: stage)
                var result = try runAgentTeams(
                    args: runtimeArgs,
                    configDirectory: config,
                    stagedRoot: stage,
                    timeoutMilliseconds: request.timeout_ms ?? 90_000
                )
                if result.0 != 0 && result.2.contains("AGENT_TEAMS_CACHED_KEY_REJECTED") {
                    try ensureDerivedTeamsKey(configDirectory: config, forceRefresh: true)
                    result = try runAgentTeams(
                        args: runtimeArgs,
                        configDirectory: config,
                        stagedRoot: stage,
                        timeoutMilliseconds: request.timeout_ms ?? 90_000
                    )
                }
                let outputFiles = result.0 == 0 ? try collectOutputFiles(outputRequests, stagedRoot: stage) : nil
                response = BridgeResponse(
                    version: 1,
                    id: request.id,
                    exit_code: result.0,
                    stdout: result.1,
                    stderr: result.2,
                    output_files: outputFiles
                )
            } catch {
                response = BridgeResponse(
                    version: 1,
                    id: responseID,
                    exit_code: 70,
                    stdout: "",
                    stderr: "\(error.localizedDescription)\n",
                    output_files: nil
                )
            }
            if let stagedRoot { try? FileManager.default.removeItem(at: stagedRoot) }
            let encodedResponse = try? JSONEncoder().encode(response)
            if let encodedResponse, encodedResponse.count <= 32 * 1_024 * 1_024 {
                reply(encodedResponse)
            } else {
                let boundedResponse = BridgeResponse(
                    version: 1,
                    id: responseID,
                    exit_code: 70,
                    stdout: "",
                    stderr: "Teams bridge response exceeded the 32 MiB safety limit.\n",
                    output_files: nil
                )
                reply((try? JSONEncoder().encode(boundedResponse)) ?? Data())
            }
        }
    }
}

private final class ListenerDelegate: NSObject, NSXPCListenerDelegate {
    private let service: TeamsBridgeService

    init(service: TeamsBridgeService) {
        self.service = service
    }

    func listener(_ listener: NSXPCListener, shouldAcceptNewConnection connection: NSXPCConnection) -> Bool {
        guard connection.effectiveUserIdentifier == getuid() else { return false }
        connection.setCodeSigningRequirement(clientRequirement)
        connection.exportedInterface = NSXPCInterface(with: TeamsBridgeXPCProtocol.self)
        connection.exportedObject = service
        connection.resume()
        return true
    }
}

private final class BridgeDelegate: NSObject, NSApplicationDelegate {
    private var listener: NSXPCListener?
    private var listenerDelegate: ListenerDelegate?
    private var sourceAccess: TeamsSourceAccess?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        do {
            let paths = BridgePaths()
            try paths.prepare()
            let access = TeamsSourceAccess(paths: paths)
            _ = access.resolveExisting()
            let service = TeamsBridgeService(paths: paths, sourceAccess: access)
            let delegate = ListenerDelegate(service: service)
            let listener = NSXPCListener(machServiceName: bridgeLabel)
            listener.delegate = delegate
            listener.resume()
            sourceAccess = access
            listenerDelegate = delegate
            self.listener = listener
        } catch {
            // Stay stopped on a deterministic startup failure. launchd does not KeepAlive this app.
            NSApp.terminate(nil)
        }
    }
}

private func openSelfTestDatabase(_ url: URL, marker: Int32) throws -> OpaquePointer {
    try ensureDirectory(url.deletingLastPathComponent())
    var database: OpaquePointer?
    guard sqlite3_open_v2(
        url.path,
        &database,
        SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX,
        nil
    ) == SQLITE_OK, let database else {
        if let database { sqlite3_close(database) }
        throw BridgeError.runtimeFailed("Unable to create a synthetic Teams database.")
    }
    let statements = [
        "PRAGMA journal_mode=WAL",
        "PRAGMA wal_autocheckpoint=0",
        "CREATE TABLE bridge_self_test (marker INTEGER NOT NULL)",
        "INSERT INTO bridge_self_test VALUES (\(marker))",
    ]
    for statement in statements where sqlite3_exec(database, statement, nil, nil, nil) != SQLITE_OK {
        sqlite3_close(database)
        throw BridgeError.runtimeFailed("Unable to populate a synthetic Teams database.")
    }
    return database
}

private func syntheticSQLiteFailure(_ message: String, database: OpaquePointer?) -> BridgeError {
    guard let database else { return .runtimeFailed("\(message) (SQLite handle unavailable.)") }
    return .runtimeFailed(
        "\(message) (SQLite \(sqlite3_errcode(database))/\(sqlite3_extended_errcode(database)): "
            + "\(String(cString: sqlite3_errmsg(database))))"
    )
}

private func readSelfTestMarker(_ url: URL) throws -> Int32 {
    var database: OpaquePointer?
    let openResult = sqlite3_open_v2(url.path, &database, SQLITE_OPEN_READONLY | SQLITE_OPEN_FULLMUTEX, nil)
    guard openResult == SQLITE_OK, let database else {
        let error = syntheticSQLiteFailure("Unable to open a staged synthetic Teams database.", database: database)
        if let database { sqlite3_close(database) }
        throw error
    }
    defer { sqlite3_close(database) }
    var statement: OpaquePointer?
    let prepareResult = sqlite3_prepare_v2(database, "SELECT marker FROM bridge_self_test", -1, &statement, nil)
    guard prepareResult == SQLITE_OK, let statement else {
        if let statement { sqlite3_finalize(statement) }
        throw syntheticSQLiteFailure("Unable to inspect a staged synthetic Teams database.", database: database)
    }
    defer { sqlite3_finalize(statement) }
    guard sqlite3_step(statement) == SQLITE_ROW else {
        throw syntheticSQLiteFailure("The staged synthetic Teams database is empty.", database: database)
    }
    return sqlite3_column_int(statement, 0)
}

private func rejectsValidatedArgs(_ request: BridgeRequest) -> Bool {
    do {
        _ = try validatedArgs(request)
        return false
    } catch BridgeError.invalidRequest {
        return true
    } catch {
        return false
    }
}

private func runSelfTest() throws {
    let valid = BridgeRequest(version: 1, id: "self-test", args: ["auth", "extract"], profile: "proof", timeout_ms: 5_000, input_files: nil, output_files: nil)
    guard try validatedArgs(valid).suffix(2) == ["--source", "desktop"] else {
        throw BridgeError.invalidRequest("Desktop source injection failed.")
    }
    let validAuthPermutations = [
        ["--account", "personal", "auth", "extract"],
        ["auth", "--team", "team", "extract", "--account=personal"],
        ["--team=team", "auth", "--account=personal", "extract", "--source=desktop"],
    ]
    for args in validAuthPermutations {
        let request = BridgeRequest(version: 1, id: "self-test", args: args, profile: "proof", timeout_ms: 5_000, input_files: nil, output_files: nil)
        let normalized = try validatedArgs(request)
        guard normalized.contains("--source=desktop") || normalized.suffix(2) == ["--source", "desktop"] else {
            throw BridgeError.invalidRequest("Root-option desktop source normalization failed.")
        }
    }
    let rejectedAuthPermutations = [
        ["auth", "login"],
        ["--account", "personal", "auth", "login"],
        ["auth", "--team=team", "login", "--account=personal"],
        ["--team", "team", "auth", "--account", "personal", "extract", "--source", "all"],
        ["auth", "--account=personal", "extract", "--source=browser"],
        ["--account=personal", "auth", "extract", "--source"],
        ["--account", "personal", "auth", "extract", "--token=synthetic"],
        ["auth", "--team=team", "extract", "--browser-profile=Default"],
    ]
    for args in rejectedAuthPermutations {
        let request = BridgeRequest(version: 1, id: "self-test", args: args, profile: "proof", timeout_ms: 5_000, input_files: nil, output_files: nil)
        guard rejectsValidatedArgs(request) else {
            throw BridgeError.invalidRequest("Auth argument guard permutation failed.")
        }
    }
    let testRoot = FileManager.default.temporaryDirectory
        .appendingPathComponent("teams-bridge-input-self-test-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: testRoot) }
    try ensureDirectory(testRoot)
    let syntheticSource = testRoot.appendingPathComponent("profiles", isDirectory: true)
    let syntheticStage = testRoot.appendingPathComponent("staged", isDirectory: true)
    let stagedDatabases = [
        ("WV2Profile_tfw/Cookies", Int32(101)),
        ("WV2Profile_tfw/Network/Cookies", Int32(102)),
        ("WV2Profile_tfl/Cookies", Int32(201)),
        ("WV2Profile_tfl/Network/Cookies", Int32(202)),
        ("Default/Cookies", Int32(301)),
        ("Default/Network/Cookies", Int32(302)),
    ]
    var syntheticDatabases: [OpaquePointer] = []
    defer { syntheticDatabases.forEach { sqlite3_close($0) } }
    for (relativePath, marker) in stagedDatabases {
        let source = syntheticSource.appendingPathComponent(relativePath, isDirectory: false)
        syntheticDatabases.append(try openSelfTestDatabase(source, marker: marker))
        guard FileManager.default.fileExists(atPath: "\(source.path)-wal") else {
            throw BridgeError.invalidRequest("Synthetic SQLite sidecar setup failed.")
        }
    }
    try snapshotTeamsProfileDatabases(sourceRoot: syntheticSource, destinationRoot: syntheticStage)
    for (relativePath, marker) in stagedDatabases {
        let staged = syntheticStage.appendingPathComponent(relativePath, isDirectory: false)
        guard FileManager.default.fileExists(atPath: staged.path) else {
            throw BridgeError.invalidRequest("A staged synthetic Teams database is missing.")
        }
        let attributes = try FileManager.default.attributesOfItem(atPath: staged.path)
        guard (attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600 else {
            throw BridgeError.invalidRequest("A staged synthetic Teams database is not mode 0600.")
        }
        let hasWAL = FileManager.default.fileExists(atPath: "\(staged.path)-wal")
        let hasSHM = FileManager.default.fileExists(atPath: "\(staged.path)-shm")
        guard !hasWAL, !hasSHM else {
            throw BridgeError.invalidRequest(
                "A staged synthetic Teams database retained a SQLite sidecar (WAL: \(hasWAL), SHM: \(hasSHM))."
            )
        }
        guard try readSelfTestMarker(staged) == marker else {
            throw BridgeError.invalidRequest("A staged synthetic Teams database lost committed WAL state.")
        }
    }
    let upload = BridgeRequest(
        version: 1,
        id: "self-test",
        args: ["--account", "work", "file", "upload", "team", "channel", "approval.png"],
        profile: "proof",
        timeout_ms: 5_000,
        input_files: [BridgeInputFile(argument_index: 6, filename: "approval.png", bytes: Data("image".utf8))],
        output_files: nil
    )
    let (stagedArgs, _) = try stagedFileArgs(upload.args, request: upload, stagedRoot: testRoot)
    guard stagedArgs[6].hasPrefix(testRoot.path),
          try Data(contentsOf: URL(fileURLWithPath: stagedArgs[6])) == Data("image".utf8) else {
        throw BridgeError.invalidRequest("Input file staging self-test failed.")
    }
    let missingInput = BridgeRequest(
        version: 1,
        id: "self-test",
        args: upload.args,
        profile: "proof",
        timeout_ms: 5_000,
        input_files: nil,
        output_files: nil
    )
    do {
        _ = try stagedFileArgs(missingInput.args, request: missingInput, stagedRoot: testRoot)
        throw BridgeError.invalidRequest("Missing input file declaration guard failed.")
    } catch BridgeError.invalidRequest {
        // Expected.
    }
    let duplicateInput = BridgeRequest(
        version: 1,
        id: "self-test",
        args: upload.args,
        profile: "proof",
        timeout_ms: 5_000,
        input_files: upload.input_files! + upload.input_files!,
        output_files: nil
    )
    do {
        _ = try stagedFileArgs(duplicateInput.args, request: duplicateInput, stagedRoot: testRoot)
        throw BridgeError.invalidRequest("Duplicate input file declaration guard failed.")
    } catch BridgeError.invalidRequest {
        // Expected.
    }
    let mismatched = BridgeRequest(
        version: 1,
        id: "self-test",
        args: ["message", "send", "team", "channel", "hello", "--file", "/outside/approval.png"],
        profile: "proof",
        timeout_ms: 5_000,
        input_files: [BridgeInputFile(argument_index: 6, filename: "approval.png", bytes: Data("image".utf8))],
        output_files: nil
    )
    do {
        _ = try stagedFileArgs(mismatched.args, request: mismatched, stagedRoot: testRoot)
        throw BridgeError.invalidRequest("Non-upload file staging guard failed.")
    } catch BridgeError.invalidRequest {
        // Expected.
    }
    let download = BridgeRequest(
        version: 1,
        id: "self-test",
        args: ["--account", "personal", "chat", "download-image", "0-frca-d16-image", "download-image"],
        profile: "proof",
        timeout_ms: 5_000,
        input_files: nil,
        output_files: [BridgeOutputFileRequest(argument_index: 5, filename: "download-image")]
    )
    let (downloadArgs, downloadOutputs) = try stagedFileArgs(download.args, request: download, stagedRoot: testRoot)
    guard downloadArgs[5].hasPrefix(testRoot.path) else {
        throw BridgeError.invalidRequest("Output file staging self-test failed.")
    }
    let stagedOutput = URL(fileURLWithPath: downloadArgs[5])
    try writePrivate(Data("downloaded".utf8), to: stagedOutput)
    guard try collectOutputFiles(downloadOutputs, stagedRoot: testRoot)?.first?.bytes == Data("downloaded".utf8) else {
        throw BridgeError.invalidRequest("Output file collection self-test failed.")
    }
    try FileManager.default.removeItem(at: stagedOutput)
    let escapedOutput = testRoot.appendingPathComponent("escaped-output", isDirectory: false)
    try Data("blocked".utf8).write(to: escapedOutput)
    try FileManager.default.createSymbolicLink(
        at: stagedOutput,
        withDestinationURL: escapedOutput
    )
    do {
        _ = try collectOutputFiles(downloadOutputs, stagedRoot: testRoot)
        throw BridgeError.invalidRequest("Symbolic-link output guard failed.")
    } catch BridgeError.runtimeFailed {
        // Expected.
    }
    let fileDownload = BridgeRequest(
        version: 1,
        id: "self-test",
        args: ["file", "--team", "team", "download", "team", "--account=work", "channel", "file", "--pretty", "download-output"],
        profile: "proof",
        timeout_ms: 5_000,
        input_files: nil,
        output_files: [BridgeOutputFileRequest(argument_index: 9, filename: "download-output")]
    )
    let (fileDownloadArgs, _) = try stagedFileArgs(fileDownload.args, request: fileDownload, stagedRoot: testRoot)
    guard fileDownloadArgs[9].hasPrefix(testRoot.path) else {
        throw BridgeError.invalidRequest("Channel file output staging self-test failed.")
    }
    let wrongCommandOutput = BridgeRequest(
        version: 1,
        id: "self-test",
        args: ["chat", "history", "chat"],
        profile: "proof",
        timeout_ms: 5_000,
        input_files: nil,
        output_files: [BridgeOutputFileRequest(argument_index: 2, filename: "chat")]
    )
    do {
        _ = try stagedFileArgs(wrongCommandOutput.args, request: wrongCommandOutput, stagedRoot: testRoot)
        throw BridgeError.invalidRequest("Wrong-command output declaration guard failed.")
    } catch BridgeError.invalidRequest {
        // Expected.
    }
    print("teams-bridge-self-test: pass")
}

if CommandLine.arguments.contains("--self-test") {
    do {
        try runSelfTest()
        exit(0)
    } catch {
        FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8))
        exit(1)
    }
}

private let application = NSApplication.shared
private let delegate = BridgeDelegate()
application.delegate = delegate
application.run()
