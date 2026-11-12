"""Conservative pre-push scan. Reports path/line only, never matching secrets.

Scans every staged file AND every blob reachable from Git refs (including local
Codex checkpoint trees). Heuristics cannot prove there are no unknown secrets;
findings must be reviewed before push. Known synthetic test fixtures are scoped.
"""
import re
import subprocess
import sys
from pathlib import PurePosixPath


def git(*args):
    return subprocess.check_output(["git", *args])


def forbidden(path):
    parts = PurePosixPath(path).parts
    name = parts[-1].lower()
    if any(p in (".data", "runtime", "backups", "node_modules", "uploads", "attachments", "release", "dist", "build", ".impeccable", "__pycache__") for p in parts):
        return True
    return ((name.startswith(".env") or name.endswith(".env")) and name != ".env.example"
            or bool(re.search(r"\.(sqlite[^/]*|db(?:-.*)?|pem|key|p12|pfx|log|zip|tgz|tar\.gz)$", name))
            or name in ("vault.key", "admin-setup.txt", "id_ed25519", "id_rsa", "auto-deploy.json", "webhook.json"))


PATTERNS = [
    re.compile(rb"-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----"),
    re.compile(rb"(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16})"),
    re.compile(rb"(?:sk-[A-Za-z0-9_-]{24,})"),
    re.compile(rb"https?://[^\s/:]+:[^\s/@]+@"),
    re.compile(rb'''(?i)(?:api[_-]?key|access[_-]?token|password|secret|token)\s*["']?\s*[:=]\s*["'][A-Za-z0-9_+/=.:-]{24,}["']'''),
]


def findings(path, data, history=False):
    # Internal checkpoint trees are never pushed. Their design notes are not
    # credentials; still scan their CONTENTS for credentials below.
    if forbidden(path) and not (history and path.startswith(".impeccable/")):
        return [(path, 0, "sensitive/artifact path")]
    result = []
    for number, line in enumerate(data.splitlines(), 1):
        for pattern in PATTERNS:
            for match in pattern.finditer(line):
                # Reviewed, synthetic fixtures only; exempt the specific match,
                # never another credential on the same source line.
                synthetic = path.startswith("tests/") and any(marker in match.group().lower() for marker in (
                    b"test-", b"synthetic", b"mock", b"fake", b"do-not-return", b"upstream-", b"fixture",
                    b"automatic-admin-password", b"confirmation-browser-password", b"input-admin-password",
                    b"integration-admin-password", b"browser-admin-password", b"a-long-password-for-admin",
                    b"production-smoke-password", b"audit-admin-password"))
                # Reviewed passwords belong only to isolated temporary test databases.
                password_fixtures = {
                    "tests/admin-password.test.ts": (
                        b"initial-admin-password-123", b"replacement-password-123",
                        b"replacement-admin-password-456", b"race-safe-admin-password-789"),
                    "tests/admin-password-browser.ts": (
                        b"browser-password-original-123", b"browser-password-replacement-456"),
                }
                synthetic |= any(marker in match.group().lower()
                                 for marker in password_fixtures.get(path, ()))
                if not synthetic:
                    result.append((path, number, "credential pattern (review required)"))
    return result


def main():
    problems, seen, files = [], set(), 0
    staged = git("ls-files", "--stage", "-z").split(b"\0")
    for entry in staged:
        if not entry:
            continue
        metadata, path = entry.split(b"\t", 1)
        mode, oid, stage = metadata.decode().split()
        label = path.decode("utf-8")
        if mode not in ("100644", "100755") or stage != "0":
            problems.append((label, 0, "symlink/submodule/unmerged entry"))
        problems += findings(label, git("cat-file", "blob", oid))
        seen.add((oid, label))
        files += 1
    # ls-tree works for both ordinary commit refs and Codex's checkpoint trees.
    refs = git("for-each-ref", "--format=%(refname)").decode().splitlines()
    roots = list(refs)
    for ref in refs:
        if git("cat-file", "-t", ref).strip() == b"commit":
            roots.extend(git("rev-list", ref).decode().splitlines())
    for root in set(roots):
        for entry in git("ls-tree", "-rz", root).split(b"\0"):
            if not entry:
                continue
            metadata, path = entry.split(b"\t", 1)
            mode, kind, oid = metadata.decode().split()
            label = path.decode("utf-8")
            if kind != "blob" or (oid, label) in seen:
                continue
            seen.add((oid, label))
            problems += [("history:" + p, n, reason) for p, n, reason in findings(label, git("cat-file", "blob", oid), history=True)]
    for path, line, reason in sorted(set(problems)):
        print(f"{path}:{line}: {reason}")
    print(f"Scanned {files} staged files and {len(seen)} unique path/blob pairs across {len(refs)} refs.")
    if not files:
        print("No staged files: stage the intended safe allowlist and rerun.")
        return 2
    if problems:
        print("STOP: review findings before any push. Secret text is intentionally omitted.")
        return 1
    print("No findings in configured path/credential rules. Review staged diff before push.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
