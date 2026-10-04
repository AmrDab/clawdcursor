#!/usr/bin/env python3
"""
Linux OCR via Tesseract (pytesseract) or tesseract CLI.
Takes an image path, outputs JSON result to stdout.
Matches the same JSON format as ocr-recognize.ps1 (Windows).

Usage: python3 ocr-recognize.py /path/to/image.png

Requires: tesseract-ocr package
  Ubuntu/Debian: sudo apt install tesseract-ocr
  Fedora:        sudo dnf install tesseract
  Arch:          sudo pacman -S tesseract

Optional: pip install pytesseract (for bounding boxes)
"""

import json
import subprocess
import sys
import os
import shutil

def parse_conf(raw):
    """Tesseract 4 prints integer confidences, tesseract 5 prints floats
    ("81.879456"); -1 marks non-word rows. int() on a float string raised
    ValueError and killed the whole OCR call on current distros."""
    try:
        return float(raw)
    except (TypeError, ValueError):
        return -1.0


def parse_tsv(tsv_text):
    """Parse `tesseract ... tsv` output into the shared {elements, fullText} shape."""
    elements = []
    lines_text = []
    current_line = -1

    for line in tsv_text.strip().split('\n')[1:]:  # skip header
        parts = line.split('\t')
        if len(parts) < 12:
            continue

        level, page, block, par, line_num, word_num = parts[:6]
        left, top, width, height = parts[6:10]
        conf = parse_conf(parts[10])
        text = parts[11].strip() if len(parts) > 11 else ''

        if not text or conf < 0:
            continue

        line_idx = int(line_num)
        if line_idx != current_line:
            current_line = line_idx
            lines_text.append(text)
        else:
            if lines_text:
                lines_text[-1] += ' ' + text

        elements.append({
            "text": text,
            "x": int(left),
            "y": int(top),
            "width": int(width),
            "height": int(height),
            "confidence": round(conf / 100, 2),
            "line": line_idx
        })

    return {
        "elements": elements,
        "fullText": '\n'.join(lines_text)
    }


def ocr_with_tesseract_cli(image_path):
    """Use tesseract CLI with TSV output for bounding boxes."""
    try:
        result = subprocess.run(
            ['tesseract', image_path, '-', 'tsv'],
            capture_output=True, text=True, timeout=30
        )
        if result.returncode != 0:
            return {"error": f"tesseract failed: {result.stderr.strip()}"}

        return parse_tsv(result.stdout)
    except FileNotFoundError:
        return {"error": "tesseract not found. Install: sudo apt install tesseract-ocr"}
    except subprocess.TimeoutExpired:
        return {"error": "tesseract timed out after 30s"}
    except Exception as e:
        return {"error": f"tesseract error: {str(e)}"}


def ocr_with_pytesseract(image_path):
    """Use pytesseract for bounding boxes (if installed)."""
    try:
        import pytesseract
        from PIL import Image

        img = Image.open(image_path)
        data = pytesseract.image_to_data(img, output_type=pytesseract.Output.DICT)

        elements = []
        lines_text = []
        current_line = -1

        for i in range(len(data['text'])):
            text = data['text'][i].strip()
            conf = parse_conf(data['conf'][i])

            if not text or conf < 0:
                continue

            line_idx = data['line_num'][i]
            if line_idx != current_line:
                current_line = line_idx
                lines_text.append(text)
            else:
                if lines_text:
                    lines_text[-1] += ' ' + text

            elements.append({
                "text": text,
                "x": data['left'][i],
                "y": data['top'][i],
                "width": data['width'][i],
                "height": data['height'][i],
                "confidence": round(conf / 100, 2),
                "line": line_idx
            })

        return {
            "elements": elements,
            "fullText": '\n'.join(lines_text)
        }
    except ImportError:
        return None  # Fall back to CLI
    except Exception as e:
        return {"error": f"pytesseract error: {str(e)}"}


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: ocr-recognize.py <image-path>"}))
        return

    image_path = sys.argv[1]
    if not os.path.isfile(image_path):
        print(json.dumps({"error": f"Image not found: {image_path}"}))
        return

    # Try pytesseract first (better bounding boxes), fall back to CLI
    result = ocr_with_pytesseract(image_path)
    if result is None:
        # pytesseract not installed, use CLI
        if shutil.which('tesseract'):
            result = ocr_with_tesseract_cli(image_path)
        else:
            result = {"error": "No OCR available. Install: sudo apt install tesseract-ocr"}

    print(json.dumps(result))


if __name__ == '__main__':
    main()
