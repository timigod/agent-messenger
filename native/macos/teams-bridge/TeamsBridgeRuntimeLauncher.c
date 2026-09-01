#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/sysctl.h>
#include <sys/types.h>
#include <unistd.h>

static const char *bridge_requirement =
    "anchor apple generic and identifier \"com.timiaji.agent-messenger-teams-bridge\" and certificate leaf[subject.OU] = \"9F4ARQ5FJR\"";
static const char *runtime_requirement =
    "anchor apple generic and identifier \"com.timiaji.agent-messenger-teams-bridge.runtime\" and certificate leaf[subject.OU] = \"9F4ARQ5FJR\"";
static const char *launcher_requirement =
    "anchor apple generic and identifier \"com.timiaji.agent-messenger-teams-bridge.launcher\" and certificate leaf[subject.OU] = \"9F4ARQ5FJR\"";

static int process_satisfies_requirement(pid_t pid, const char *requirement_text) {
  CFNumberRef pid_number = CFNumberCreate(NULL, kCFNumberIntType, &pid);
  if (pid_number == NULL) return 0;
  const void *keys[] = {kSecGuestAttributePid};
  const void *values[] = {pid_number};
  CFDictionaryRef attributes = CFDictionaryCreate(
      NULL, keys, values, 1, &kCFTypeDictionaryKeyCallBacks,
      &kCFTypeDictionaryValueCallBacks);
  CFRelease(pid_number);
  if (attributes == NULL) return 0;

  SecCodeRef code = NULL;
  OSStatus status = SecCodeCopyGuestWithAttributes(
      NULL, attributes, kSecCSDefaultFlags, &code);
  CFRelease(attributes);
  if (status != errSecSuccess || code == NULL) return 0;

  CFStringRef requirement_string = CFStringCreateWithCString(
      NULL, requirement_text, kCFStringEncodingUTF8);
  if (requirement_string == NULL) {
    CFRelease(code);
    return 0;
  }
  SecRequirementRef requirement = NULL;
  status = SecRequirementCreateWithString(
      requirement_string, kSecCSDefaultFlags, &requirement);
  CFRelease(requirement_string);
  if (status != errSecSuccess || requirement == NULL) {
    CFRelease(code);
    return 0;
  }
  status = SecCodeCheckValidity(code, kSecCSStrictValidate, requirement);
  CFRelease(requirement);
  CFRelease(code);
  return status == errSecSuccess;
}

static pid_t parent_pid(pid_t pid) {
  int mib[] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, pid};
  struct kinfo_proc info;
  size_t length = sizeof(info);
  memset(&info, 0, sizeof(info));
  if (sysctl(mib, 4, &info, &length, NULL, 0) != 0 || length == 0) return -1;
  return info.kp_eproc.e_ppid;
}

static int verify_runtime_invocation(void) {
  pid_t runtime_pid = getppid();
  pid_t bridge_pid = parent_pid(runtime_pid);
  return process_satisfies_requirement(getpid(), launcher_requirement) &&
         process_satisfies_requirement(runtime_pid, runtime_requirement) &&
         bridge_pid > 0 &&
         process_satisfies_requirement(bridge_pid, bridge_requirement);
}

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "--verify-invocation") == 0) {
    if (verify_runtime_invocation()) return 0;
    fputs("Teams bridge runtime invocation could not be verified.\n", stderr);
    return 77;
  }
  if (argc < 2) {
    fputs("Teams bridge runtime path is missing.\n", stderr);
    return 64;
  }
  if (!process_satisfies_requirement(getpid(), launcher_requirement) ||
      !process_satisfies_requirement(getppid(), bridge_requirement)) {
    fputs("Teams bridge runtime parent could not be verified.\n", stderr);
    return 77;
  }
  if (setpgid(0, 0) != 0) {
    perror("setpgid");
    return 70;
  }
  if (setenv("AGENT_TEAMS_COMPANION_MEDIATED", "1", 1) != 0) {
    perror("setenv");
    return 70;
  }
  execv(argv[1], &argv[1]);
  perror("execv");
  return errno == ENOENT ? 127 : 70;
}
