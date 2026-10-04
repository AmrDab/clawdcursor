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


# Screen text is small, sparse UI labels, not a page of prose: the default
# page-segmentation mode finds nothing on a typical desktop. Sparse-text mode
# on a 2x-upscaled capture (the caller upscales and passes the factor) reads
# the labels; coordinates are divided back to real screen pixels.
PSM = '11'


def parse_tsv(tsv_text, scale=1.0):
    """Parse `tesseract ... tsv` output into the shared {elements, fullText} shape."""
    elements = []
    lines_text = []
    current_line = None

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
        # line_num restarts in every block/paragraph — key on all three.
        line_key = (block, par, line_num)
        if line_key != current_line:
            current_line = line_key
            lines_text.append(text)
        else:
            if lines_text:
                lines_text[-1] += ' ' + text

        elements.append({
            "text": text,
            "x": round(int(left) / scale),
            "y": round(int(top) / scale),
            "width": round(int(width) / scale),
            "height": round(int(height) / scale),
            "confidence": round(conf / 100, 2),
            "line": line_idx
        })

    return {
        "elements": elements,
        "fullText": '\n'.join(lines_text)
    }


def ocr_with_tesseract_cli(image_path, scale=1.0):
    """Use tesseract CLI with TSV output for bounding boxes."""
    try:
        result = subprocess.run(
            ['tesseract', image_path, '-', '--psm', PSM, 'tsv'],
            capture_output=True, text=True, timeout=30
        )
        if result.returncode != 0:
            return {"error": f"tesseract failed: {result.stderr.strip()}"}

        return parse_tsv(result.stdout, scale)
    except FileNotFoundError:
        return {"error": "tesseract not found. Install: sudo apt install tesseract-ocr"}
    except subprocess.TimeoutExpired:
        return {"error": "tesseract timed out after 30s"}
    except Exception as e:
        return {"error": f"tesseract error: {str(e)}"}


def ocr_with_pytesseract(image_path, scale=1.0):
    """Use pytesseract for bounding boxes (if installed)."""
    try:
        import pytesseract
        from PIL import Image

        img = Image.open(image_path)
        data = pytesseract.image_to_data(img, config=f'--psm {PSM}', output_type=pytesseract.Output.DICT)

        elements = []
        lines_text = []
        current_line = None

        for i in range(len(data['text'])):
            text = data['text'][i].strip()
            conf = parse_conf(data['conf'][i])

            if not text or conf < 0:
                continue

            line_idx = data['line_num'][i]
            line_key = (data['block_num'][i], data['par_num'][i], line_idx)
            if line_key != current_line:
                current_line = line_key
                lines_text.append(text)
            else:
                if lines_text:
                    lines_text[-1] += ' ' + text

            elements.append({
                "text": text,
                "x": round(data['left'][i] / scale),
                "y": round(data['top'][i] / scale),
                "width": round(data['width'][i] / scale),
                "height": round(data['height'][i] / scale),
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
        print(json.dumps({"error": "Usage: ocr-recognize.py <image-path> [scale]"}))
        return

    image_path = sys.argv[1]
    # The caller may pass an upscaled capture plus its factor (see PSM above).
    try:
        scale = float(sys.argv[2]) if len(sys.argv) > 2 else 1.0
    except ValueError:
        scale = 1.0
    if scale <= 0:
        scale = 1.0
    if not os.path.isfile(image_path):
        print(json.dumps({"error": f"Image not found: {image_path}"}))
        return

    # Try pytesseract first (better bounding boxes), fall back to CLI
    result = ocr_with_pytesseract(image_path, scale)
    if result is None:
        # pytesseract not installed, use CLI
        if shutil.which('tesseract'):
            result = ocr_with_tesseract_cli(image_path, scale)
        else:
            result = {"error": "No OCR available. Install: sudo apt install tesseract-ocr"}

    print(json.dumps(result))


if __name__ == '__main__':
    main()
