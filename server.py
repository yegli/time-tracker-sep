import os
import re
from flask import Flask, jsonify, send_from_directory, abort, request

app = Flask(__name__, static_folder="static", static_url_path="")

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")


# ---------------------------------------------------------------------------
# Static frontend
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


# ---------------------------------------------------------------------------
# Sprint list
# ---------------------------------------------------------------------------

@app.route("/api/sprints")
def list_sprints():
    """Return a sorted list of available sprint CSV files."""
    files = sorted(f for f in os.listdir(DATA_DIR) if f.endswith(".csv"))
    sprints = [{"filename": f, "label": _filename_to_label(f)} for f in files]
    return jsonify(sprints)


# ---------------------------------------------------------------------------
# Sprint CSV content
# ---------------------------------------------------------------------------

@app.route("/api/sprint/<path:filename>")
def get_sprint(filename):
    """Return raw CSV content for a given sprint file."""
    if os.sep in filename or "/" in filename or not filename.endswith(".csv"):
        abort(400, description="Invalid filename.")
    return send_from_directory(DATA_DIR, filename, mimetype="text/csv")


# ---------------------------------------------------------------------------
# Sprint upload
# ---------------------------------------------------------------------------

@app.route("/api/sprint/upload", methods=["POST"])
def upload_sprint():
    """Accept a CSV file upload and save it to the data directory."""
    if "file" not in request.files:
        abort(400, description="No file part in request.")
    f = request.files["file"]
    if not f.filename:
        abort(400, description="Empty filename.")
    # Sanitise: strip all path components to prevent directory traversal
    safe_name = os.path.basename(f.filename.replace("\\", "/"))
    if not safe_name.lower().endswith(".csv"):
        abort(400, description="Only .csv files are accepted.")
    # Read up to 10 MB + 1 byte to detect oversized uploads
    chunk = f.read(10 * 1024 * 1024 + 1)
    if len(chunk) > 10 * 1024 * 1024:
        abort(400, description="File exceeds 10 MB limit.")
    dest = os.path.join(DATA_DIR, safe_name)
    with open(dest, "wb") as out:
        out.write(chunk)
    return jsonify({"filename": safe_name, "label": _filename_to_label(safe_name)})


# ---------------------------------------------------------------------------
# Epic mapping (optional — returns null when the file does not exist)
# ---------------------------------------------------------------------------

@app.route("/api/epic-mapping")
def epic_mapping():
    """Return epic-mapping.json if present in data/, otherwise null."""
    path = os.path.join(DATA_DIR, "epic-mapping.json")
    if os.path.isfile(path):
        return send_from_directory(DATA_DIR, "epic-mapping.json", mimetype="application/json")
    return jsonify(None)


# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------

def _filename_to_label(filename: str) -> str:
    """Convert a CSV filename to a human-readable sprint label.

    Examples
    --------
    sprint_1.csv                                 ->  Sprint #1
    worklogs_from_01-02-2026_to_28-02-2026.csv  ->  Feb 2026
    anything_else.csv                            ->  anything_else
    """
    name = filename[:-4]  # strip .csv

    # sprint_N  →  Sprint #N
    m = re.match(r"sprint_(\d+)$", name, re.IGNORECASE)
    if m:
        return f"Sprint #{m.group(1)}"

    # worklogs_from_DD-MM-YYYY_to_...  →  Mon YYYY
    m = re.match(r"worklogs_from_\d{2}-(\d{2})-(\d{4})_to_", name)
    if m:
        months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
        return f"{months[int(m.group(1)) - 1]} {m.group(2)}"

    return name


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    debug = os.environ.get("DEBUG") == "1"
    port = int(os.environ.get("PORT", 8080))
    app.run(host="0.0.0.0", port=port, debug=debug)
