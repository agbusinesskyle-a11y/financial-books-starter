# scripts/tax-catalog-check.py — prints "line | IRS label" pairs from a 2025 form PDF so a person can compare them with the catalog.
# Usage: python -I scripts/tax-catalog-check.py <pdf path> ; PDFs: https://www.irs.gov/pub/irs-pdf/f1065.pdf, f1120s.pdf, f1040sc.pdf, f1040se.pdf, f1040sf.pdf, f1125a.pdf, f8825.pdf, f1065sk1.pdf, f1120ssk.pdf
# IRS forms put a line's number and its label in separate text runs, and some print rotated side labels ("Deductions") beside the lines. The
# horizontal runs are regrouped into the lines a reader sees (same baseline, left to right) before the line numbers are picked out.
# Item letters (K-1 items E..N) and sub-line letters (b, c) are kept.
import sys, re, fitz

LINE_NO = re.compile(r'^(\d{1,2}[a-z]?|[A-Za-z])$')
LEADER = re.compile(r'(\s*\.){2,}')

def visual_lines(page, tolerance=2.5):
    runs = []  # (baseline, left edge, text) of every horizontal run
    for block in page.get_text('dict')['blocks']:
        for run in block.get('lines', []):
            text = ''.join(span['text'] for span in run['spans']).strip()
            if text and abs(run['dir'][1]) < 0.01:
                runs.append((run['spans'][0]['origin'][1], run['bbox'][0], text))
    lines = []  # each: [baseline, [(left edge, text)]]
    for baseline, left, text in sorted(runs):
        if lines and abs(lines[-1][0] - baseline) <= tolerance:
            lines[-1][1].append((left, text))
        else:
            lines.append([baseline, [(left, text)]])
    for _, parts in lines:
        yield ' '.join(text for _, text in sorted(parts)).split()

if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace', newline='\n')
    doc = fitz.open(sys.argv[1])
    for number, page in enumerate(doc, 1):
        for tokens in visual_lines(page):
            if len(tokens) > 1 and LINE_NO.match(tokens[0]):
                label = LEADER.sub(' ...', ' '.join(tokens[1:])).strip()
                print(f'p{number} {tokens[0]:>4} | {label[:110]}')
