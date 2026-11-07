def slugify(text: str, max_length: int = 50) -> str:
    """Return a URL slug.

    - lowercase ASCII letters and digits are kept
    - any run of other characters becomes a single hyphen
    - no leading/trailing hyphens
    - accented Latin letters are transliterated (é -> e, ü -> u, ñ -> n)
    - the result is at most max_length characters and does not end with a hyphen
    """
    raise NotImplementedError
