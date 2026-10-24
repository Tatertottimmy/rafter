"""Build index.html (a full HTML document for ordinary web hosting) from page.html.

page.html is the body-only source that the claude.ai artifact host wraps itself.
Run:  python build.py
"""
from pathlib import Path

HERE = Path(__file__).parent
body = (HERE / "page.html").read_text(encoding="utf-8")
doc = (
    "<!doctype html>\n<html lang=\"en\">\n<head>\n"
    "<meta charset=\"utf-8\">\n"
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">\n"
    "<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}"
    "body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>\n"
    "</head>\n<body>\n" + body + "\n</body>\n</html>\n"
)
(HERE / "index.html").write_text(doc, encoding="utf-8")
print(f"wrote index.html ({len(doc)} bytes)")
