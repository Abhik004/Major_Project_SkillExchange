import re
import os
import pdfplumber
import pytesseract
from pdf2image import convert_from_path
import requests
from bs4 import BeautifulSoup
from flask import Flask, request, jsonify

# ================== FLASK APP ==================
print("THIS IS THE FILE BEING RUN")
app = Flask(__name__)

UPLOAD_FOLDER = "uploads"
os.makedirs(UPLOAD_FOLDER, exist_ok=True)


# ================== TEXT EXTRACTION ==================
def extract_text_from_pdf(pdf_path):
    text = ""
    try:
        with pdfplumber.open(pdf_path) as pdf:
            for page in pdf.pages:
                t = page.extract_text()
                if t:
                    text += t + "\n"
    except:
        pass
    return text


# ================== OCR FALLBACK ==================
def extract_text_with_ocr(pdf_path):
    text = ""
    try:
        images = convert_from_path(pdf_path)
        for img in images:
            text += pytesseract.image_to_string(img)
    except:
        pass
    return text


# ================== PARSE PDF ==================
def extract_pdf_details(text):
    # Extract Coursera verification link
    link_match = re.search(r"https://coursera\.org/verify/\S+", text)
    link = link_match.group(0) if link_match else None

    lines = [l.strip() for l in text.split("\n") if l.strip()]

    # Extract name (heuristic)
    name = None
    for i, line in enumerate(lines):
        if re.search(r"\d{4}", line):  # likely date line
            if i + 1 < len(lines):
                name = lines[i + 1]
                break

    # Extract course (basic heuristic)
    course = None
    for line in lines:
        if any(keyword in line.lower() for keyword in [
            "machine learning", "deep learning", "data science",
            "python", "ai", "neural"
        ]):
            course = line
            break

    return name, course, link


# ================== FETCH WEB DATA ==================
def extract_web_details(url):
    try:
        headers = {"User-Agent": "Mozilla/5.0"}
        res = requests.get(url, headers=headers, timeout=10)

        if res.status_code != 200:
            return None

        soup = BeautifulSoup(res.text, "html.parser")
        return soup.get_text().lower()
    except:
        return None


# ================== ROUTE ==================
@app.route("/verify", methods=["POST"])
def verify():
    if "file" not in request.files:
        return jsonify({"status": 0, "error": "No file uploaded"})

    file = request.files["file"]
    
    if file.filename == '':
        return jsonify({"status": 0, "error": "Empty filename"})
        
    file_path = os.path.join(UPLOAD_FOLDER, file.filename)
    file.save(file_path)

    text = ""

    # Handle PDF or Direct Image
    if file.filename.lower().endswith(".pdf"):
        text = extract_text_from_pdf(file_path)
        if not text.strip():
            text = extract_text_with_ocr(file_path)
    else:
        text = pytesseract.image_to_string(file_path)

    if not text.strip():
        os.remove(file_path)
        return jsonify({"status": 0, "error": "Could not extract text"})

    name, course, link = extract_pdf_details(text)

    if not link:
        os.remove(file_path)
        return jsonify({
            "status": 0,
            "error": "No verification link found in the document"
        })

    credential_id = link.split("/")[-1]

    # Fetch live data from Coursera
    web_text = extract_web_details(link)

    if not web_text:
        os.remove(file_path)
        return jsonify({"status": 0, "error": "Could not fetch verification page from Coursera"})

    # Cross-reference the extracted PDF data with the live Web data
    name_match = name and name.lower() in web_text
    course_match = course and course.lower() in web_text

    os.remove(file_path)

    # Validate matches
    if name_match and course_match:
        return jsonify({
            "status": 1,
            "data": {
                "name": name,
                "course": course,
                "link": link,
                "credential_id": credential_id
            }
        })
    else:
        return jsonify({
            "status": 0,
            "error": "Certificate details do not match Coursera's official records"
        })

# ================== RUN SERVER ==================
if __name__ == "__main__":
    app.run(port=5005, debug=True, use_reloader=False)