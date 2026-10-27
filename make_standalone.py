"""Build one self-contained EcoPlanter HTML file (Windows, macOS, Linux).

Place this script beside index.html, styles.css, app.js and the assets folder.
Run it with: python make_standalone.py
"""

from pathlib import Path
import base64
import mimetypes
import re
import sys

# Use the script's own directory (NOT a Linux-specific /mnt/data path).
ROOT = Path(__file__).resolve().parent
OUTPUT_FILE = ROOT / "EcoPlanter_Website.html"


def load_text(filename: str) -> str:
    path = ROOT / filename
    if not path.is_file():
        raise FileNotFoundError(f"Required file not found: {path}")
    return path.read_text(encoding="utf-8")


def file_as_data_uri(relative_path: str) -> str:
    """Convert a local image into a data: URL so the HTML runs offline."""
    path = (ROOT / relative_path).resolve()
    # Do not read files outside the EcoPlanter project directory.
    if not path.is_relative_to(ROOT):
        raise ValueError(f"Unsafe asset path: {relative_path}")
    if not path.is_file():
        raise FileNotFoundError(f"Asset not found: {path}")

    media_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{media_type};base64,{encoded}"


def main() -> None:
    html = load_text("index.html")
    css = load_text("styles.css")
    javascript = load_text("app.js")

    # Inline images referenced by CSS, for example url('assets/background.webp').
    css = re.sub(
        r"url\(\s*(['\"]?)(assets/[^'\")]+)\1\s*\)",
        lambda match: 'url("' + file_as_data_uri(match.group(2)) + '")',
        css,
    )

    # Inline the CSS stylesheet.
    css_link = '<link rel="stylesheet" href="styles.css" />'
    if css_link not in html:
        raise ValueError('Could not find the styles.css <link> in index.html')
    html = html.replace(css_link, "<style>\n" + css + "\n</style>")

    # Inline local images and the SVG favicon used in HTML.
    html = re.sub(
        r'\b(src|href)="(assets/[^"]+)"',
        lambda match: f'{match.group(1)}="{file_as_data_uri(match.group(2))}"',
        html,
    )

    # Inline the JavaScript, preserving the existing site functionality.
    js_tag = '<script src="app.js" defer></script>'
    if js_tag not in html:
        raise ValueError('Could not find the app.js <script> in index.html')
    html = html.replace(js_tag, "<script>\n" + javascript + "\n</script>")

    OUTPUT_FILE.write_text(html, encoding="utf-8")
    print("Website generated successfully!")
    print(f"Location: {OUTPUT_FILE}")
    print("Double-click EcoPlanter_Website.html to open it in your browser.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)
