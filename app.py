import argparse
import base64
import hashlib
import json
import os
import re
import shutil
import subprocess
import time
from collections import OrderedDict
from threading import Thread
from zipfile import ZipFile
from tempfile import TemporaryDirectory
from uuid import uuid4
from pathlib import Path
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlsplit
from urllib.error import URLError
from urllib.request import Request, urlopen
import webbrowser

import pymupdf as pdf
from converter import DOCX_MIME, KINDS, convert

ROOT = Path(__file__).resolve().parent
MAX_EDIT_REQUEST = 100 * 1024 * 1024
CHUNK_SIZE = 1024 * 1024
HISTORY_LIMIT = 10
PREVIEW_CACHE_BYTES = 24 * 1024 * 1024
PREVIEW_CACHE_ENTRIES = 128
PREVIEW_PIXELS = {"full": 1200, "thumb": 120, "thumb2": 240}
COMPRESSION_PRESETS = {"high": (200, 82), "medium": (150, 67), "low": (96, 45)}
APP_VERSION = (14, 1, 10)
THEMES = {"purple", "blue", "green", "dark"}
RELEASE_REPOSITORY = "mertdmrc8/TugbayReader"
INSTALLER_NAME = "TugbayReader-Kurulum.exe"
MAX_INSTALLER_SIZE = 250 * 1024 * 1024


def available_update(release):
    tag = release.get("tag_name", "")
    match = re.fullmatch(r"v(\d+)(?:\.(\d+)\.(\d+))?", tag)
    if not match or release.get("draft") or release.get("prerelease"):
        return None
    version = tuple(int(part or 0) for part in match.groups())
    installer = next((asset for asset in release.get("assets", [])
                      if asset.get("name") == INSTALLER_NAME and asset.get("state") == "uploaded"), None)
    if version <= APP_VERSION or installer is None:
        return None
    update = {"version": tag, "url": f"https://github.com/{RELEASE_REPOSITORY}/releases/tag/{tag}"}
    digest = installer.get("digest")
    size = installer.get("size")
    if (isinstance(digest, str) and re.fullmatch(r"sha256:[0-9a-f]{64}", digest)
            and type(size) is int and 0 < size <= MAX_INSTALLER_SIZE):
        update.update(sha256=digest.removeprefix("sha256:"), size=size)
    return update


def check_for_update(server):
    request = Request(
        f"https://api.github.com/repos/{RELEASE_REPOSITORY}/releases/latest",
        headers={"Accept": "application/vnd.github+json", "User-Agent": "TugbayReader"},
    )
    try:
        with urlopen(request, timeout=4) as response:
            release = json.loads(response.read(256 * 1024))
        server.update = available_update(release)
        server.update_check = "ready"
    except (OSError, URLError, ValueError, TypeError, AttributeError):
        server.update_check = "error"


def schedule_update_check(server, force=False):
    now = time.monotonic()
    if server.update_check == "checking" or (not force and now - server.update_checked_at < 60):
        return
    server.update_checked_at = now
    server.update_check = "checking"
    Thread(target=check_for_update, args=(server,), daemon=True).start()


def favorite_ids(values):
    if not isinstance(values, list):
        return []
    return list(dict.fromkeys(value for value in values[:40]
                              if isinstance(value, str) and re.fullmatch(r"[a-zA-Z0-9_-]{1,32}", value)))


def save_preference(path, value):
    if path is None:
        return
    draft = path.with_name(uuid4().hex + ".tmp")
    try:
        draft.write_text(json.dumps(value), encoding="utf-8")
        draft.replace(path)
    finally:
        draft.unlink(missing_ok=True)


def download_installer(update, destination, progress):
    url = f"https://github.com/{RELEASE_REPOSITORY}/releases/download/{update['version']}/{INSTALLER_NAME}"
    request = Request(url, headers={"User-Agent": "TugbayReader"})
    checksum = hashlib.sha256()
    received = 0
    with urlopen(request, timeout=15) as response, destination.open("xb") as installer:
        final = urlsplit(response.geturl())
        if final.scheme != "https" or final.hostname not in (
            "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"
        ):
            raise ValueError("Güncelleme indirme adresi doğrulanamadı.")
        while chunk := response.read(CHUNK_SIZE):
            received += len(chunk)
            if received > update["size"]:
                raise ValueError("Kurucu dosyasının boyutu doğrulanamadı.")
            installer.write(chunk)
            checksum.update(chunk)
            progress(received * 100 // update["size"])
    if received != update["size"] or checksum.hexdigest() != update["sha256"]:
        raise ValueError("Kurucunun SHA-256 doğrulaması başarısız oldu.")


def install_update(server, update):
    try:
        with TemporaryDirectory(prefix="TugbayReader-Update-") as directory:
            installer = Path(directory) / INSTALLER_NAME
            def progress(percent):
                server.update_status = {"phase": "download", "percent": percent}

            download_installer(update, installer, progress)
            server.update_status = {"phase": "install"}
            flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
            result = subprocess.run([str(installer)], check=False, creationflags=flags)
            if result.returncode:
                raise ValueError("Windows kurucusu güncellemeyi tamamlayamadı.")
    except (OSError, ValueError) as error:
        message = str(error) if isinstance(error, ValueError) else "Kurucu indirilemedi veya çalıştırılamadı."
        server.update_status = {"phase": "error", "message": message}
        return
    server.update_status = {"phase": "installed"}
    time.sleep(4)
    server.shutdown()


def decode(data):
    return base64.b64decode(data, validate=True)


def open_pdf(path):
    doc = pdf.open(path)
    if not doc.is_pdf or doc.needs_pass or not doc.page_count:
        doc.close()
        raise ValueError("Açılabilir, şifresiz bir PDF seçin.")
    return doc


def font_name(name):
    normalized = "".join(char for char in name.split("+")[-1].lower() if char.isalnum())
    return normalized.removesuffix("regular")


def replacement_font(page, span, text):
    wanted = font_name(span["font"])
    for xref, _, _, name, *_ in page.get_fonts():
        if font_name(name) != wanted:
            continue
        buffer = page.parent.extract_font(xref)[3] if xref else None
        if buffer:
            try:
                font = pdf.Font(fontbuffer=buffer)
                if all(font.has_glyph(ord(char), fallback=False) for char in text):
                    resource = f"TugbayOriginal{xref}"
                    return resource, font, {"fontbuffer": buffer}
            except (ValueError, RuntimeError):
                continue

    for resource in ("helv", "hebo", "heit", "hebi", "tiro", "tibo", "tiit",
                     "tibi", "cour", "cobo", "coit", "cobi"):
        font = pdf.Font(fontname=resource)
        if font_name(font.name) == wanted and all(
            ord(char) <= 255 and font.has_glyph(ord(char), fallback=False) for char in text
        ):
            return resource, font, {}

    font_dir = Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts"
    flags = span["flags"]
    style = ("bi" if flags & 16 and flags & 2 else "bd" if flags & 16
             else "i" if flags & 2 else "")
    if flags & 8:
        filename = {"": "cour.ttf", "bd": "courbd.ttf", "i": "couri.ttf", "bi": "courbi.ttf"}[style]
    elif flags & 4:
        filename = "times" + style + ".ttf"
    else:
        filename = "arial" + style + ".ttf"
    path = font_dir / filename
    resource = "Tugbay" + path.stem
    return resource, pdf.Font(fontfile=str(path)), {"fontfile": str(path)}


class Editor:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.data = None
        self.saved_path = None
        self.undo_stack = []
        self.redo_stack = []
        self.uploads = {}
        self.exports = {}
        self.preview_path = None
        self.previews = OrderedDict()
        self.preview_bytes = 0

    def receive(self, stream, length):
        token = uuid4().hex
        path = self.directory / (token + ".pdf")
        try:
            with path.open("wb") as output:
                while length:
                    chunk = stream.read(min(CHUNK_SIZE, length))
                    if not chunk:
                        raise ValueError("Dosya aktarımı yarıda kesildi.")
                    output.write(chunk)
                    length -= len(chunk)
        except (ValueError, OSError):
            path.unlink(missing_ok=True)
            raise
        self.uploads[token] = path
        return token

    def discard_upload(self, token):
        path = self.uploads.pop(token, None)
        if path is not None:
            path.unlink(missing_ok=True)

    def save(self, doc, garbage=1):
        path = self.directory / (uuid4().hex + ".pdf")
        try:
            doc.save(path, garbage=garbage)
        except Exception:
            path.unlink(missing_ok=True)
            raise
        return path

    def replace(self, path, previous=None):
        discarded = self.redo_stack[:]
        self.redo_stack.clear()
        if previous is None:
            discarded.extend(self.undo_stack)
            self.undo_stack.clear()
            if self.data is not None:
                discarded.append(self.data)
        else:
            self.undo_stack.append(previous)
            if len(self.undo_stack) > HISTORY_LIMIT:
                discarded.append(self.undo_stack.pop(0))
        for old in discarded:
            old.unlink(missing_ok=True)
        self.data = path

    def document(self):
        if self.data is None:
            raise ValueError("Önce bir PDF açın.")
        return pdf.open(self.data)

    def render_page(self, index, size):
        if self.data != self.preview_path:
            self.previews.clear()
            self.preview_bytes = 0
            self.preview_path = self.data
        printing = size == "print"
        limit = (min(3600, max(1200, int(size))) if size.isdigit()
                 else PREVIEW_PIXELS.get(size, 120))
        key = (index, limit)
        if not printing and key in self.previews:
            self.previews.move_to_end(key)
            return self.previews[key]
        with self.document() as doc:
            page = doc[index]
            rect = page.rect
            longest = max(rect.width, rect.height)
            scale = min(2.5, 4096 / longest) if printing else limit / longest
            image = page.get_pixmap(matrix=pdf.Matrix(scale, scale)).tobytes("png")
        if not printing and len(image) <= PREVIEW_CACHE_BYTES:
            while (len(self.previews) >= PREVIEW_CACHE_ENTRIES
                   or self.preview_bytes + len(image) > PREVIEW_CACHE_BYTES):
                self.preview_bytes -= len(self.previews.popitem(last=False)[1])
            self.previews[key] = image
            self.preview_bytes += len(image)
        return image

    def apply(self, action, args):
        index = int(args.get("page", 0))
        if action in ("append", "insert"):
            self.add_pdf_pages(index, action == "insert", args)
        elif action in ("undo", "redo"):
            source, target = ((self.undo_stack, self.redo_stack) if action == "undo"
                              else (self.redo_stack, self.undo_stack))
            if not source:
                raise ValueError("Bu yönde işlem geçmişi yok.")
            target.append(self.data)
            self.data = source.pop()
        elif action == "open":
            token = args["token"]
            path = self.uploads[token]
            with open_pdf(path):
                pass
            self.uploads.pop(token)
            self.replace(path)
            self.saved_path = path
        else:
            self.modify_document(index, action, args)
        return self.state()

    def state(self):
        with self.document() as doc:
            return {"count": len(doc), "undo": bool(self.undo_stack), "redo": bool(self.redo_stack),
                    "ratios": [page.rect.width / page.rect.height for page in doc]}

    def open_local(self, source):
        with source.open("rb") as stream:
            token = self.receive(stream, source.stat().st_size)
        try:
            self.apply("open", {"token": token})
        finally:
            self.discard_upload(token)

    def add_pdf_pages(self, index, insert_after, args):
        sources = args["files"]
        if not sources:
            raise ValueError("Eklenecek en az bir PDF seçin.")
        existing = None if args.get("newDocument") else self.data
        with (pdf.open(existing) if existing is not None else pdf.open()) as doc:
            position = index + 1 if insert_after and len(doc) else len(doc)
            for source in sources:
                try:
                    with open_pdf(self.uploads[source["token"]]) as other:
                        doc.insert_pdf(other, start_at=position)
                        position += len(other)
                except (ValueError, RuntimeError) as error:
                    raise ValueError(f'{source["name"]}: PDF eklenemedi. Dosyanın geçerli ve şifresiz olduğunu kontrol edin.') from error
            edited = self.save(doc)
        self.replace(edited, existing)

    def modify_document(self, index, action, args):
        with self.document() as doc:
            page = doc[index]
            if action == "delete":
                pages = self.indices(doc, args.get("pages", [index]))
                if len(pages) >= len(doc):
                    raise ValueError("PDF’de en az bir sayfa kalmalı.")
                doc.delete_pages(pages)
            elif action == "blank":
                doc.new_page(index + 1, width=page.rect.width, height=page.rect.height)
            elif action == "reorder":
                order = list(range(len(doc)))
                order.insert(int(args["to"]), order.pop(index))
                doc.select(order)
            elif action == "rotate":
                for number in self.indices(doc, args.get("pages", [index])):
                    target = doc[number]
                    target.set_rotation((target.rotation + int(args["angle"])) % 360)
            elif action == "compress":
                dpi, quality = COMPRESSION_PRESETS[args["quality"]]
                doc.rewrite_images(dpi_threshold=dpi + 1, dpi_target=dpi, quality=quality, bitonal=False)
            elif action == "ocr":
                for number in self.indices(doc, args.get("pages", [index])):
                    self.ocr(doc[number])
            elif action in ("crop", "highlight", "redact", "note", "add_text"):
                self.mark(page, action, args)
            elif action in ("text", "image", "signature", "add_image"):
                self.edit(page, action, args)
            else:
                raise ValueError("Bilinmeyen işlem.")
            edited = self.save(doc, garbage=4 if action in ("redact", "compress") else 1)
        if action == "compress" and edited.stat().st_size >= self.data.stat().st_size:
            edited.unlink()
            raise ValueError("Bu ayarla dosya küçülmedi. Daha düşük kaliteyi deneyin.")
        self.replace(edited, self.data)

    def indices(self, doc, values):
        pages = sorted(set(map(int, values)))
        if not pages or pages[0] < 0 or pages[-1] >= len(doc):
            raise ValueError("Geçerli sayfa numaraları seçin.")
        return pages

    def export(self, groups):
        with self.document() as doc:
            verified = [self.indices(doc, group) for group in groups]
            if not verified:
                raise ValueError("Çıkarılacak sayfaları seçin.")
            parts = []
            token = uuid4().hex
            archive = self.directory / (token + ".zip")
            try:
                for pages in verified:
                    with pdf.open() as part:
                        for number in pages:
                            part.insert_pdf(doc, from_page=number, to_page=number, final=0)
                        parts.append(self.save(part))
                if len(parts) == 1:
                    self.exports[token] = parts.pop()
                    return {"token": token, "extension": "pdf"}
                with ZipFile(archive, "w") as zipped:
                    for number, part in enumerate(parts, 1):
                        zipped.write(part, f"Bolum-{number}.pdf")
                self.exports[token] = archive
                return {"token": token, "extension": "zip"}
            except Exception:
                archive.unlink(missing_ok=True)
                raise
            finally:
                for part in parts:
                    part.unlink(missing_ok=True)

    def convert(self, kind, inputs):
        if kind not in KINDS:
            raise ValueError("Geçerli bir dönüşüm seçin.")
        if inputs:
            sources = [(self.uploads[item["token"]], Path(item["name"]).suffix.lower()) for item in inputs]
        elif kind.startswith("pdf-") and self.data is not None:
            sources = [(self.data, ".pdf")]
        else:
            raise ValueError("Dönüştürülecek dosyayı seçin.")
        token = uuid4().hex
        extension = KINDS[kind][0]
        target = self.directory / (token + extension)
        try:
            convert(kind, sources, target)
        except Exception:
            target.unlink(missing_ok=True)
            raise
        self.exports[token] = target
        return {"token": token, "extension": extension}

    def search(self, query):
        if not query.strip():
            return []
        matches = []
        with self.document() as doc:
            for page in doc:
                for box in page.search_for(query, quads=False):
                    area = (box * page.rotation_matrix) & page.rect
                    if not area.is_empty:
                        matches.append({"page": page.number, "box": [
                            area.x0 / page.rect.width, area.y0 / page.rect.height,
                            area.x1 / page.rect.width, area.y1 / page.rect.height]})
        return matches

    def mark(self, page, action, args):
        x, y = args["point"]
        point = pdf.Point(x * page.rect.width, y * page.rect.height)
        if action == "note":
            page.add_text_annot(point * page.derotation_matrix, args["text"])
            return
        if action == "add_text":
            page.insert_text(point * page.derotation_matrix, args["text"], fontsize=int(args["size"]),
                             fontname="TugbayArial", fontfile=self.arial(), rotate=page.rotation)
            return
        x2, y2 = args["end"]
        box = pdf.Rect(point, pdf.Point(x2 * page.rect.width, y2 * page.rect.height))
        box.normalize()
        box = (box & page.rect) * page.derotation_matrix
        if box.width < 2 or box.height < 2:
            raise ValueError("Sayfada daha geniş bir alan seçin.")
        if action == "crop":
            box += tuple(page.cropbox_position) * 2
            page.set_cropbox(box)
        elif action == "highlight":
            page.add_highlight_annot(box)
        else:
            for annotation in list(page.annots()):
                if annotation.rect.intersects(box):
                    page.delete_annot(annotation)
            for widget in list(page.widgets()):
                if widget.rect.intersects(box):
                    page.delete_widget(widget)
            page.add_redact_annot(box, fill=(0, 0, 0), cross_out=False)
            page.apply_redactions(images=2, graphics=2, text=0)

    @staticmethod
    def arial():
        return str(Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts" / "arial.ttf")

    def ocr(self, page):
        if page.get_text().strip():
            return
        tessdata = ROOT / "tessdata"
        if not (tessdata / "tur.traineddata").is_file():
            raise ValueError("Türkçe OCR modeli bulunamadı. Uygulama paketini yeniden çıkarın.")
        scale = min(2.5, 3500 / max(page.rect.width, page.rect.height))
        pixmap = page.get_pixmap(matrix=pdf.Matrix(scale, scale), annots=False)
        try:
            detected = pixmap.pdfocr_tobytes(language="tur+eng", tessdata=str(tessdata))
        except RuntimeError as error:
            raise ValueError("OCR çalıştırılamadı. PDF motorunu ve dil dosyalarını kontrol edin.") from error
        font_path = self.arial()
        font = pdf.Font(fontfile=font_path)
        with pdf.open(stream=detected, filetype="pdf") as scan:
            ratio = page.rect.width / scan[0].rect.width
            for x0, y0, x1, y1, word, *_ in scan[0].get_text("words"):
                point = pdf.Point(x0 * ratio, y1 * ratio) * page.derotation_matrix
                size = max(1, (y1 - y0) * ratio * .8)
                width = font.text_length(word, fontsize=size)
                stretch = ((x1 - x0) * ratio / width) if width else 1
                matrix = pdf.Matrix(stretch, 1) if page.rotation % 180 == 0 else pdf.Matrix(1, stretch)
                page.insert_text(point, word, fontsize=size, fontname="TugbayArial", fontfile=font_path,
                                 rotate=page.rotation, render_mode=3, morph=(point, matrix))

    def objects(self, page):
        spans = {}
        flags = pdf.TEXTFLAGS_DICT & ~pdf.TEXT_PRESERVE_IMAGES
        for block in page.get_text("dict", flags=flags)["blocks"]:
            for line in block.get("lines", []):
                for span in line["spans"]:
                    if span["text"].strip() and line["dir"][0] > 0.999:
                        spans[f"t{len(spans)}"] = span
        images = {f"i{i}": item for i, item in enumerate(page.get_image_info())}
        return spans, images

    def inspect(self, index):
        with self.document() as doc:
            page = doc[index]
            spans, images = self.objects(page)
            def visible_box(box):
                rect = (pdf.Rect(box) * page.rotation_matrix) & page.rect
                return [rect.x0 / page.rect.width, rect.y0 / page.rect.height,
                        rect.x1 / page.rect.width, rect.y1 / page.rect.height]
            items = [{"id": uid, "box": visible_box(span["bbox"]), "text": span["text"]}
                     for uid, span in spans.items()]
            items += [{"id": uid, "box": visible_box(item["bbox"])}
                      for uid, item in images.items()]
            items += [{"id": f"n{annotation.xref}", "box": visible_box(annotation.rect),
                       "note": annotation.info["content"]}
                      for annotation in page.annots() if annotation.type[1] == "Text"]
            return items

    def edit(self, page, action, args):
        if action == "add_image":
            data = decode(args["data"])
            pixmap = pdf.Pixmap(data)
            width = page.rect.width * float(args["size"]) / 100
            height = width * pixmap.height / pixmap.width
            if height > page.rect.height:
                width *= page.rect.height / height
                height = page.rect.height
            x, y = args["point"]
            left = max(0, min(page.rect.width - width, x * page.rect.width - width / 2))
            top = max(0, min(page.rect.height - height, y * page.rect.height - height / 2))
            box = pdf.Rect(left, top, left + width, top + height) * page.derotation_matrix
            page.insert_image(box, stream=data, rotate=page.rotation)
            return
        if action == "signature":
            width = page.rect.width * 0.23
            x = min(max(float(args["x"]) * page.rect.width - width / 2, 0), page.rect.width - width)
            height = min(width / 3, page.rect.height)
            y = min(max(float(args["y"]) * page.rect.height - height / 2, 0), page.rect.height - height)
            box = pdf.Rect(x, y, x + width, y + height) * page.derotation_matrix
            page.insert_image(box, stream=decode(args["data"]), rotate=page.rotation)
            return
        spans, images = self.objects(page)
        if action == "text":
            span = spans[args["id"]]
            replacement = args["text"]
            if len(replacement) > 2000 or "\n" in replacement or "\r" in replacement:
                raise ValueError("Tek satırda en fazla 2000 karakter girin.")
            if replacement == span["text"]:
                return
            box = pdf.Rect(span["bbox"])
            mid = (box.y0 + box.y1) / 2
            hit = pdf.Rect(box.x0 + 0.03, mid - 0.03, box.x1 - 0.03, mid + 0.03)
            if replacement:
                fontname, font, font_source = replacement_font(page, span, replacement)
            page.add_redact_annot(hit, fill=False, cross_out=False)
            page.apply_redactions(images=0, graphics=0, text=0)
            if replacement:
                page.insert_font(fontname=fontname, **font_source)
                font_size = span["size"]
                width = font.text_length(replacement, fontsize=font_size)
                scale = min(1, box.width / width) if width else 1
                rgb = tuple(((span["color"] >> shift) & 255) / 255 for shift in (16, 8, 0))
                origin = pdf.Point(span["origin"])
                page.insert_text(origin, replacement, fontname=fontname, fontsize=font_size, color=rgb,
                                 morph=(origin, pdf.Matrix(scale, 1)))
            return
        box = pdf.Rect(images[args["id"]]["bbox"])
        page.add_redact_annot(box, fill=False, cross_out=False)
        page.apply_redactions(images=2, graphics=0, text=1)
        if args.get("data"):
            page.insert_image(box, stream=decode(args["data"]))


class ReaderServer(HTTPServer):
    request_queue_size = 32


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, data, content_type, status=200):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; frame-ancestors 'none'")
        self.end_headers()
        self.wfile.write(data)

    def json_reply(self, data, status=200):
        self.reply(json.dumps(data).encode(), "application/json", status)

    def allowed(self):
        host = f"127.0.0.1:{self.server.server_port}"
        return self.headers.get("Host") == host and self.headers.get("Origin", f"http://{host}") == f"http://{host}"

    def do_GET(self):
        if not self.allowed():
            self.send_error(403)
            return
        url = urlsplit(self.path)
        path = url.path
        assets = {"/": ("index.html", "text/html; charset=utf-8"),
                  "/style.css": ("style.css", "text/css; charset=utf-8"),
                  "/app.js": ("app.js", "text/javascript; charset=utf-8"),
                  "/TugbayReader.png": ("TugbayReader.png", "image/png"),
                  "/TugbayReader.ico": ("TugbayReader.ico", "image/vnd.microsoft.icon")}
        try:
            if path in assets:
                name, mime = assets[path]
                self.reply((ROOT / name).read_bytes(), mime)
            elif path.startswith("/export/"):
                token = path.rsplit("/", 1)[-1]
                exported = self.server.editor.exports.pop(token, None)
                if exported is None:
                    self.send_error(404)
                    return
                try:
                    self.send_file(exported)
                finally:
                    exported.unlink(missing_ok=True)
            elif path == "/search":
                query = parse_qs(url.query).get("q", [""])[0]
                self.json_reply(self.server.editor.search(query[:200]))
            elif path == "/update":
                self.json_reply({"available": self.server.update, "installable": self.server.update_installable,
                                 "status": self.server.update_status, "check": self.server.update_check})
            elif path == "/print-info":
                with self.server.editor.document() as doc:
                    self.json_reply([[page.rect.width, page.rect.height] for page in doc])
            elif path == "/favorites":
                self.json_reply(self.server.favorites)
            elif path == "/theme":
                self.json_reply(self.server.theme)
            elif path == "/startup":
                state = self.server.startup.copy()
                if state.get("name"):
                    state.update(self.server.editor.state())
                self.json_reply(state)
            elif path == "/pdf":
                if self.server.editor.data is None:
                    self.json_reply({"error": "Önce bir PDF açın."}, 404)
                    return
                self.send_file(self.server.editor.data)
                self.server.editor.saved_path = self.server.editor.data
            elif path.startswith("/objects/"):
                self.json_reply(self.server.editor.inspect(int(path.split("/")[-1])))
            elif path.startswith("/page/"):
                _, _, index, size = path.split("/")
                self.reply(self.server.editor.render_page(int(index), size), "image/png")
            else:
                self.send_error(404)
        except (BrokenPipeError, ConnectionResetError):
            return
        except (ValueError, RuntimeError, IndexError, KeyError):
            self.json_reply({"error": "Sayfa veya dosya görüntülenemedi."}, 400)

    def send_file(self, path):
        with path.open("rb") as document:
            self.send_response(200)
            mime = {".zip": "application/zip", ".pdf": "application/pdf", ".docx": DOCX_MIME,
                    ".txt": "text/plain; charset=utf-8"}.get(path.suffix, "application/octet-stream")
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(path.stat().st_size))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            shutil.copyfileobj(document, self.wfile, CHUNK_SIZE)

    def do_POST(self):
        if not self.allowed():
            self.send_error(403)
            return
        editor = self.server.editor
        try:
            length = int(self.headers["Content-Length"])
            media = self.headers.get_content_type()
            if self.path == "/upload" and media == "application/octet-stream" and length > 0:
                self.json_reply({"token": editor.receive(self.rfile, length)})
                return
            if self.path not in ("/edit", "/discard", "/export", "/convert", "/update/install",
                                 "/update/check", "/favorites", "/theme") or media != "application/json":
                self.send_error(403)
                return
            if not 0 < length <= MAX_EDIT_REQUEST:
                raise ValueError("Dosya boyutu sınırı aşıldı.")
            args = json.loads(self.rfile.read(length))
            if self.path == "/favorites":
                favorites = favorite_ids(args["items"])
                save_preference(self.server.favorites_path, favorites)
                self.server.favorites = favorites
                self.json_reply(favorites)
                return
            if self.path == "/theme":
                theme = args.get("theme")
                if not isinstance(theme, str) or theme not in THEMES:
                    raise ValueError("Geçerli bir tema seçin.")
                save_preference(self.server.theme_path, theme)
                self.server.theme = theme
                self.json_reply(theme)
                return
            if self.path == "/update/check":
                schedule_update_check(self.server, force=args.get("force") is True)
                self.json_reply({"check": self.server.update_check})
                return
            if self.path == "/update/install":
                self.start_update(args.get("version"))
                return
            if self.path == "/export":
                self.json_reply(editor.export(args["groups"]))
                return
            if self.path == "/convert":
                self.json_reply(editor.convert(args["kind"], args["inputs"]))
                return
            if self.path == "/discard":
                for token in args["tokens"]:
                    editor.discard_upload(token)
                self.json_reply({})
                return
            if self.server.update_status.get("phase") in ("download", "install", "installed"):
                self.json_reply({"error": "Güncelleme kurulurken belge düzenlenemez."}, 409)
                return
            self.json_reply(editor.apply(args["action"], args))
        except OSError:
            self.json_reply({"error": "Dosya diske yazılamadı. Boş disk alanını kontrol edin."}, 507)
        except (ValueError, RuntimeError, KeyError, TypeError, IndexError) as error:
            message = str(error)
            if not any(letter in message for letter in "çğıöşüÇĞİÖŞÜ"):
                message = "İşlem tamamlanamadı. Dosyayı veya seçimi kontrol edin."
            self.json_reply({"error": message}, 400)

    def start_update(self, version):
        update = self.server.update
        if not self.server.update_installable or not update or "sha256" not in update or version != update["version"]:
            self.json_reply({"error": "Doğrulanabilir bir Windows güncellemesi bulunamadı."}, 400)
            return
        phase = self.server.update_status.get("phase")
        if phase in ("download", "install", "installed"):
            self.json_reply({"error": "Güncelleme işlemi zaten başladı."}, 409)
            return
        editor = self.server.editor
        if editor.data is not None and editor.data != editor.saved_path:
            self.json_reply({"error": "Önce açık PDF’yi indir, ardından güncellemeyi yeniden başlat."}, 409)
            return
        self.server.update_status = {"phase": "download", "percent": 0}
        Thread(target=install_update, args=(self.server, update), daemon=True).start()
        self.json_reply({"started": True}, 202)


def run_server(args, session=None):
    with TemporaryDirectory(prefix="TugbayReader-") as directory, ReaderServer(("127.0.0.1", args.port), Handler) as server:
        server.editor = Editor(directory)
        server.update = None
        server.update_check = "idle"
        server.update_checked_at = float("-inf")
        server.update_installable = (ROOT / "runtime" / "pythonw.exe").is_file()
        server.favorites_path = ROOT.parent / "favorites.json" if server.update_installable else None
        server.theme_path = ROOT.parent / "theme.json" if server.update_installable else None
        server.theme = "purple"
        if server.theme_path is not None:
            try:
                preferred_theme = json.loads(server.theme_path.read_text(encoding="utf-8"))
                if isinstance(preferred_theme, str) and preferred_theme in THEMES:
                    server.theme = preferred_theme
            except (OSError, ValueError):
                pass
        server.favorites = []
        if server.favorites_path is not None:
            try:
                server.favorites = favorite_ids(json.loads(server.favorites_path.read_text(encoding="utf-8")))
            except (OSError, ValueError):
                pass
        server.update_status = {}
        server.startup = {}
        if args.file is not None:
            try:
                server.editor.open_local(args.file)
                server.startup = {"name": args.file.name}
            except (OSError, ValueError, RuntimeError):
                server.startup = {"error": f"{args.file.name} açılamadı. Geçerli, şifresiz bir PDF seçin."}
        if not args.no_browser:
            schedule_update_check(server)
        url = f"http://127.0.0.1:{server.server_port}"
        if session is not None:
            session.seek(1)
            session.write(url.encode("ascii"))
            session.truncate()
            session.flush()
        print(f"TugbayReader | {url}", flush=True)
        if not args.no_browser:
            webbrowser.open(url)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


def run_desktop(args):
    import msvcrt

    path = ROOT / ".session"
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_BINARY)
    with os.fdopen(fd, "r+b", buffering=0) as session:
        try:
            msvcrt.locking(session.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            for _ in range(30):
                session.seek(1)
                url = session.read().decode("ascii", errors="ignore")
                if url.startswith("http://127.0.0.1:") and url.rsplit(":", 1)[-1].isdigit():
                    if not args.no_browser:
                        webbrowser.open(url)
                    return
                time.sleep(.1)
            return
        session.truncate(1)
        run_server(args, session)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--desktop", action="store_true")
    parser.add_argument("--file", type=Path)
    args = parser.parse_args()
    if args.desktop and args.file is None:
        run_desktop(args)
    else:
        run_server(args)
