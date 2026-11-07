import re

def parse_duration(text: str) -> int:
    m = re.fullmatch(r"(?:(\d+)h)?(?:(\d+)m)?", text.strip())
    if not m or not text.strip():
        raise ValueError(f"bad duration: {text!r}")
    h, mi = (int(g) if g else 0 for g in m.groups())
    return h * 3600 + mi * 60
