"""Local format conversions for TugbayReader."""
import os
from pathlib import Path
import shutil
import subprocess
from tempfile import TemporaryDirectory
from xml.etree.ElementTree import Element, SubElement, tostring, fromstring
from zipfile import ZIP_DEFLATED, ZipFile

import pymupdf as pdf

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
REL = "http://schemas.openxmlformats.org/package/2006/relationships"
CT = "http://schemas.openxmlformats.org/package/2006/content-types"
DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
KINDS = {
    "pdf-docx": (".docx", {".pdf"}),
    "word-pdf": (".pdf", {".doc", ".docx"}),
    "pdf-txt": (".txt", {".pdf"}),
    "pdf-png": (".zip", {".pdf"}),
    "pdf-jpeg": (".zip", {".pdf"}),
    "images-pdf": (".pdf", {".png", ".jpg", ".jpeg"}),
}


def w(node, tag, **attributes):
    return SubElement(node, "{" + W + "}" + tag, {"{" + W + "}" + k: str(v) for k, v in attributes.items()})


def xml_text(text):
    return "".join(c for c in text if c in "\t\n\r" or 32 <= ord(c) <= 0xD7FF
                   or 0xE000 <= ord(c) <= 0xFFFD or ord(c) >= 0x10000)


def add_text_block(paragraph, lines):
    for index, line in enumerate(lines):
        if index:
            w(w(paragraph, "r"), "br")
        for span in line["spans"]:
            run = w(paragraph, "r")
            style = w(run, "rPr")
            if span["flags"] & 16:
                w(style, "b")
            if span["flags"] & 2:
                w(style, "i")
            w(style, "color", val=f'{span["color"]:06X}')
            w(style, "sz", val=max(14, min(80, round(span["size"] * 2))))
            text = w(run, "t")
            text.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
            text.text = xml_text(span["text"])


def add_picture(paragraph, archive, relations, image_id, content, width, height):
    part = f"image-{image_id}.png"
    archive.writestr("word/media/" + part, content)
    SubElement(relations, "Relationship", Id=f"rId{image_id}", Type=R + "/image", Target="media/" + part)
    factor = min(1, 456 / width, 628 / height)
    cx, cy = max(1, round(width * factor * 12700)), max(1, round(height * factor * 12700))
    drawing = f'''<wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
        xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
        xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:r="{R}">
      <wp:extent cx="{cx}" cy="{cy}"/><wp:docPr id="{image_id}" name="{part}"/>
      <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
        <pic:pic><pic:nvPicPr><pic:cNvPr id="{image_id}" name="{part}"/><pic:cNvPicPr/></pic:nvPicPr>
          <pic:blipFill><a:blip r:embed="rId{image_id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
          <pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm>
            <a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>
        </pic:pic>
      </a:graphicData></a:graphic>
    </wp:inline>'''
    w(w(paragraph, "r"), "drawing").append(fromstring(drawing))


def pdf_to_docx(document, target):
    root = Element("{" + W + "}document")
    body = w(root, "body")
    content_types = Element("Types", xmlns=CT)
    for extension, mime in (("rels", "application/vnd.openxmlformats-package.relationships+xml"),
                            ("png", "image/png")):
        SubElement(content_types, "Default", Extension=extension, ContentType=mime)
    SubElement(content_types, "Override", PartName="/word/document.xml", ContentType=DOCX_MIME + ".main+xml")
    package = Element("Relationships", xmlns=REL)
    SubElement(package, "Relationship", Id="rId1", Type=R + "/officeDocument", Target="word/document.xml")
    relations = Element("Relationships", xmlns=REL)
    image_id = 0
    with ZipFile(target, "w", compression=ZIP_DEFLATED) as archive:
        for page in document:
            if page.get_text().strip():
                blocks = page.get_text("dict", sort=True)["blocks"]
            else:
                blocks = [{"type": 1, "image": page.get_pixmap(dpi=144).tobytes("png"), "bbox": page.rect}]
            for block_index, block in enumerate(blocks):
                paragraph = w(body, "p")
                settings = w(paragraph, "pPr")
                if block_index == 0 and page.number:
                    w(settings, "pageBreakBefore")
                w(settings, "spacing", after=75)
                if block["type"] == 0:
                    add_text_block(paragraph, block["lines"])
                elif block["type"] == 1:
                    image_id += 1
                    pix = pdf.Pixmap(block["image"])
                    if pix.colorspace and pix.colorspace.n > 3:
                        pix = pdf.Pixmap(pdf.csRGB, pix)
                    bounds = pdf.Rect(block["bbox"])
                    if bounds.width and bounds.height:
                        add_picture(paragraph, archive, relations, image_id, pix.tobytes("png"),
                                    bounds.width, bounds.height)
        section = w(body, "sectPr")
        w(section, "pgSz", w=12240, h=15840)
        w(section, "pgMar", top=1440, right=1440, bottom=1440, left=1440, header=720, footer=720, gutter=0)
        for name, element in (("[Content_Types].xml", content_types), ("_rels/.rels", package),
                              ("word/document.xml", root), ("word/_rels/document.xml.rels", relations)):
            archive.writestr(name, tostring(element, encoding="utf-8", xml_declaration=True))


def word_to_pdf(source, suffix, target):
    with TemporaryDirectory(prefix="word-", dir=target.parent) as folder:
        staged = Path(folder) / ("Belge" + suffix)
        shutil.copyfile(source, staged)
        helper = Path(__file__).with_name("WordConverter.exe")
        if not helper.is_file():
            source_code = helper.parent / "installer/WordConverter.cs"
            compiler = Path(os.environ.get("WINDIR", "")) / "Microsoft.NET/Framework64/v4.0.30319/csc.exe"
            if compiler.is_file() and source_code.is_file():
                helper = Path(folder) / "WordConverter.exe"
                subprocess.run([str(compiler), "/nologo", "/target:winexe", "/reference:Microsoft.CSharp.dll",
                                "/out:" + str(helper), str(source_code)], capture_output=True, check=False)
        if not helper.is_file():
            raise ValueError("Word dönüştürme bileşeni bulunamadı. TugbayReader’ı kurucu ile yükleyin.")
        try:
            result = subprocess.run(
                [str(helper), str(staged), str(target)],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0), check=False,
            )
        except subprocess.TimeoutExpired as error:
            raise ValueError("Word dönüşümü zaman aşımına uğradı. Belgenin açılabildiğini kontrol edin.") from error
        if result.returncode == 20:
            raise ValueError("Word → PDF için Microsoft Word yüklü ve etkin olmalı.")
        if result.returncode or not target.is_file():
            raise ValueError("Word belgesi dönüştürülemedi. Belgenin şifresini veya Word’de açılıp açılmadığını kontrol edin.")


def convert(kind, sources, target):
    _, allowed = KINDS[kind]
    if not sources or (kind != "images-pdf" and len(sources) != 1):
        raise ValueError("Dönüştürmek için uygun sayıda dosya seçin.")
    if any(suffix not in allowed for _, suffix in sources):
        raise ValueError("Seçili dosya biçimi bu dönüştürme türüne uygun değil.")
    source, suffix = sources[0]
    if kind == "word-pdf":
        word_to_pdf(source, suffix, target)
        return
    if kind == "images-pdf":
        with pdf.open() as result:
            for path, extension in sources:
                with pdf.open(path, filetype=extension.lstrip(".")) as image:
                    converted = image.convert_to_pdf()
                with pdf.open(stream=converted, filetype="pdf") as pages:
                    result.insert_pdf(pages)
            result.save(target, garbage=1)
        return
    with pdf.open(source) as document:
        if not document.is_pdf or not len(document) or document.needs_pass:
            raise ValueError("Geçerli ve şifresiz bir PDF seçin.")
        if kind == "pdf-docx":
            pdf_to_docx(document, target)
        elif kind == "pdf-txt":
            with target.open("w", encoding="utf-8-sig", newline="\n") as output:
                for page in document:
                    if page.number:
                        output.write("\n\f\n")
                    output.write(page.get_text(sort=True))
        else:
            format_name = kind.removeprefix("pdf-")
            extension = "jpg" if format_name == "jpeg" else "png"
            with ZipFile(target, "w") as archive:
                for page in document:
                    dpi = 144
                    if max(page.rect.width, page.rect.height) > 2048:
                        dpi = max(1, int(4096 * 72 / max(page.rect.width, page.rect.height)))
                    pix = page.get_pixmap(dpi=dpi)
                    archive.writestr(f"Sayfa-{page.number + 1:04d}.{extension}", pix.tobytes(format_name))
