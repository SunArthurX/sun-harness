import re

EMAIL = re.compile(r"^[a-z]+@[a-z]+(\.[a-z]+)?$")

def is_valid_email(s: str) -> bool:
    return bool(EMAIL.match(s))
