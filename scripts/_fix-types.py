#!/usr/bin/env python3
from pathlib import Path
import re

for p in list(Path("src").rglob("*.ts")) + list(Path("tests").rglob("*.ts")):
    t = p.read_text(encoding="utf-8")
    o = t
    t = re.sub(r"([A-Za-z_\]>])\s*\|\|\s*(null|undefined)\b", r"\1 | \2", t)
    t = re.sub(r"'([^']*)'\s*\|\|\s*'", r"'\1' | '", t)
    t = re.sub(
        r"\b(string|number|boolean)\s*\|\|\s*(string|number|boolean|null|undefined)",
        r"\1 | \2",
        t,
    )
    # runtime: keep || for assignments like `x || null` when left is lowercase identifier alone after :
    # matchedNumber: foo || null is runtime - our first sub makes foo | null which is wrong for values
    # re-fix lowercase prop assignments
    t = re.sub(
        r"(matchedNumber|lastMessagePreview|body|caption|preview|mediaUrl):\s*([a-z][\w.]*)\s*\|\s*null",
        r"\1: \2 || null",
        t,
    )
    if t != o:
        p.write_text(t, encoding="utf-8")
        print("fixed", p)
