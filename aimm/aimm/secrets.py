"""秘密扫描：记录、提炼、导入前执行。只报告规则名和行号，绝不回显命中的内容。"""

from __future__ import annotations

import re

_PATTERNS = [
    ("private-key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("aws-access-key", re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")),
    ("aliyun-access-key", re.compile(r"\bLTAI[0-9A-Za-z]{12,}\b")),
    ("api-key", re.compile(r"\bsk-[A-Za-z0-9_-]{20,}")),
    ("github-token", re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})")),
    ("slack-token", re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}")),
    ("jwt", re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}")),
    ("url-credential", re.compile(r"[a-zA-Z][a-zA-Z0-9+.-]*://[^\s/:@]+:[^\s/@<>{}$*]{4,}@")),
]

_ASSIGN_RE = re.compile(
    r"(?i)(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key(?:[_-]?secret)?|密码|口令|密钥)"
    r"[\"']?\s*[:=：]\s*[\"'`]?([^\s\"'`，。；,;]{8,})"
)
_PLACEHOLDER_RE = re.compile(r"[<>{}$*]|x{3,}|\.{3}|…|example|placeholder|your[_-]", re.IGNORECASE)


def _looks_like_secret(value: str) -> bool:
    if _PLACEHOLDER_RE.search(value):
        return False
    return bool(re.search(r"[A-Za-z]", value) and re.search(r"\d", value))


def scan(text: str) -> list:
    """返回 [(规则名, 行号)]，按行号排序。"""
    findings = []
    for number, line in enumerate(text.split("\n"), start=1):
        for rule, pattern in _PATTERNS:
            if pattern.search(line):
                findings.append((rule, number))
        match = _ASSIGN_RE.search(line)
        if match and _looks_like_secret(match.group(1)):
            findings.append(("credential-assignment", number))
    return findings


def describe(findings: list) -> str:
    return "；".join(f"第 {number} 行命中 {rule}" for rule, number in findings)
