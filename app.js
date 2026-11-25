"use strict";
const get = id => document.getElementById(id);
const actionButtons = [...document.querySelectorAll("[data-action]")];
const modeButtons = [...document.querySelectorAll("[data-mode]")];
const documentButtons = [...document.querySelectorAll("[data-document]")];
const editorButtons = [...actionButtons, ...modeButtons, ...documentButtons, get("sign"), get("download")];
let page = 0;
let count = 0;
let revision = 0;
let filename = "";
let canUndo = false;
let canRedo = false;
let zoom = "fit";
const zoomLevels = Array.from(get("zoom").options, option => option.value);
let matches = [];
let matchIndex = 0;
const selectedPages = new Set();
const areaModes = ["crop", "highlight", "redact"];
let busy = false;
let currentMode = "";
let fileAction = "open";
let selectedId = "";
let signatureData = "";
let newImage = null;
let frames = [];
let thumbnails = [];
let activeThumbnail = null;
let scrollFrame = 0;
let automaticScroll = false;
let placement = null;
let targetRequest = 0;

function notify(message = "", error = false) {
  get("status").textContent = message;
  get("status").classList.toggle("error", error);
}

function controls() {
  get("previousPage").disabled = busy || page === 0;
  get("nextPage").disabled = busy || page >= count - 1;
  for (const button of editorButtons) {
    const acceptsEmpty = ["append", "insert"].includes(button.dataset.action);
    button.disabled = busy || (!count && !acceptsEmpty) || (button.dataset.action === "delete" && count < 2);
  }
  get("undo").disabled = busy || !canUndo;
  get("redo").disabled = busy || !canRedo;
  get("pagePosition").disabled = busy || !count;
  get("zoom").disabled = busy || !count;
  get("zoomOut").disabled = busy || !count || zoom === zoomLevels[0];
  get("zoomIn").disabled = busy || !count || zoom === zoomLevels.at(-1);
  get("open").disabled = busy;
  get("updateButton").disabled = busy;
  get("openConvert").disabled = busy;
  get("printPdf").disabled = busy || !count;
  get("choose").disabled = busy;
  get("quickMerge").disabled = busy;
}

function loadPage() {
  get("viewerBar").hidden = !count;
  get("pagePosition").textContent = `${page + 1} / ${count}`;
  controls();
  get("sheet").hidden = !count;
  get("pageStack").hidden = !count;
  get("welcome").hidden = Boolean(count);
  get("count").textContent = count;
  get("noPages").hidden = Boolean(count);
  get("fileName").textContent = count ? `${filename} · ${page + 1} / ${count}` : "Belge açık değil";
  if (!count) return;
  get("pageImage")?.removeAttribute("id");
  const frame = frames[page];
  frame.firstElementChild.id = "pageImage";
  frame.append(get("sheet"));
  activeThumbnail?.removeAttribute("aria-current");
  activeThumbnail = thumbnails[page];
  activeThumbnail.setAttribute("aria-current", "page");
  drawTargets();
  paintSearch();
}

function navigate(index, offset = 0) {
  if (busy || index < 0 || index >= count) return;
  if (index !== page) cancelPlacement();
  page = index;
  loadPage();
  scrollToPage(offset);
}

function scrollToPage(offset = 0) {
  const viewer = get("workspace");
  automaticScroll = true;
  viewer.scrollTop += frames[page].getBoundingClientRect().top - viewer.getBoundingClientRect().top - 12 + offset;
  requestAnimationFrame(() => requestAnimationFrame(() => { automaticScroll = false; }));
}

function resizeStack() {
  const scale = zoom === "fit" ? 1 : Number(zoom);
  const pixels = Math.round(760 * scale);
  const width = scale < 1 ? `min(${scale * 100}%, ${pixels}px)` : `${pixels}px`;
  get("pageStack").style.width = zoom === "fit" ? "" : width;
  const resolution = scale <= 1 ? "full" : Math.round(1200 * scale);
  for (const [index, frame] of frames.entries()) {
    const image = frame.firstElementChild;
    const source = `/page/${index}/${resolution}?v=${revision}`;
    if (image.getAttribute("src") !== source) image.src = source;
  }
}

function loadFrames(ratios) {
  const stack = get("pageStack");
  get("workspace").append(get("sheet"));
  frames = ratios.map((ratio, index) => {
    const frame = document.createElement("div");
    frame.className = "page-frame";
    frame.dataset.page = index;
    frame.style.aspectRatio = ratio;
    const image = document.createElement("img");
    image.alt = `Sayfa ${index + 1}`;
    image.loading = "lazy";
    image.draggable = false;
    frame.append(image);
    frame.onclick = () => {
      if (busy || page === index) return;
      cancelPlacement();
      page = index;
      loadPage();
    };
    return frame;
  });
  stack.replaceChildren(...frames);
  resizeStack();
}

get("workspace").addEventListener("scroll", () => {
  if (scrollFrame || automaticScroll || busy || placement || !frames.length) return;
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0;
    if (automaticScroll || busy || placement) return;
    const viewer = get("workspace");
    const marker = viewer.getBoundingClientRect().top + Math.min(165, viewer.clientHeight / 3);
    let low = 0;
    let high = frames.length - 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (frames[middle].getBoundingClientRect().bottom < marker) low = middle + 1;
      else high = middle;
    }
    if (low === page) return;
    page = low;
    loadPage();
  });
}, {passive: true});

get("previousPage").onclick = () => navigate(page - 1);
get("nextPage").onclick = () => navigate(page + 1);

function loadThumbnail(image, fallback, index) {
  const base = `/page/${index}/`;
  const version = revision;
  let attempt = 0;
  fallback.hidden = true;
  image.hidden = false;
  image.onload = () => { fallback.hidden = true; };
  image.onerror = () => {
    if (!image.isConnected || version !== revision) return;
    attempt += 1;
    if (attempt === 1) {
      image.src = `${base}thumb?v=${version}&retry=${Date.now()}`;
    } else if (attempt === 2) {
      image.src = `${base}thumb2?v=${version}`;
    } else {
      image.hidden = true;
      fallback.hidden = false;
    }
  };
  image.src = `${base}thumb?v=${version}&request=${Date.now()}`;
}

function loadThumbnails() {
  thumbnails = [];
  activeThumbnail = null;
  const buttons = Array.from({ length: count }, (_, index) => {
    const button = document.createElement("button");
    thumbnails.push(button);
    button.className = "thumb";
    button.dataset.index = index;
    button.draggable = true;
    button.setAttribute("aria-label", `Sayfa ${index + 1}`);
    const image = document.createElement("img");
    image.alt = "";
    image.loading = "lazy";
    const fallback = document.createElement("span");
    fallback.className = "thumbnail-fallback";
    fallback.textContent = "Tekrar dene";
    const preview = document.createElement("span");
    preview.className = "thumbnail-preview";
    preview.append(image, fallback);
    loadThumbnail(image, fallback, index);
    button.append(preview, String(index + 1));
    button.addEventListener("click", () => {
      if (!busy && !fallback.hidden) loadThumbnail(image, fallback, index);
      navigate(index);
    });
    const tile = document.createElement("div");
    tile.className = "page-tile";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "page-select";
    checkbox.setAttribute("aria-label", `Sayfa ${index + 1} seç`);
    checkbox.checked = selectedPages.has(index);
    checkbox.onchange = () => {
      if (busy) {
        checkbox.checked = selectedPages.has(index);
        return;
      }
      if (checkbox.checked) selectedPages.add(index);
      else selectedPages.delete(index);
    };
    button.ondragstart = event => {
      if (busy) return event.preventDefault();
      event.dataTransfer.setData("application/x-tugbay-page", String(index));
      event.dataTransfer.effectAllowed = "move";
    };
    tile.ondragover = event => {
      if (event.dataTransfer.types.includes("application/x-tugbay-page")) {
        event.preventDefault();
        tile.classList.add("drop-page");
      }
    };
    tile.ondragleave = () => tile.classList.remove("drop-page");
    tile.ondrop = event => {
      tile.classList.remove("drop-page");
      const source = event.dataTransfer.getData("application/x-tugbay-page");
      if (source === "" || Number(source) === index || busy) return;
      event.preventDefault();
      edit("reorder", { page: Number(source), to: index });
    };
    tile.append(button, checkbox);
    return tile;
  });
  get("pages").replaceChildren(...buttons);
}

function setMode(mode = "") {
  cancelPlacement();
  currentMode = mode;
  for (const button of modeButtons) button.setAttribute("aria-pressed", String(button.dataset.mode === mode));
  get("sign").setAttribute("aria-pressed", String(mode === "signature"));
  get("sheet").classList.toggle("placing", mode === "signature" || areaModes.includes(mode) || ["note", "add_text", "add_image"].includes(mode));
  get("sheet").classList.toggle("selecting-area", areaModes.includes(mode));
  if (mode === "signature") notify("İmzayı yerleştirmek için sayfaya tıklayın.");
  else if (areaModes.includes(mode)) notify("Sayfada bir alan seçmek için sürükleyin.");
  else if (["note", "add_text", "add_image"].includes(mode)) notify("Yerleştirmek için sayfaya tıklayın.");
  else if (!mode) notify();
  drawTargets();
}

async function drawTargets() {
  const request = ++targetRequest;
  get("targets").replaceChildren();
  if (!["text", "image", "note"].includes(currentMode) || !count) return;
  try {
    const response = await fetch(`/objects/${page}?v=${revision}`);
    if (!response.ok) throw new Error("Sayfadaki öğeler okunamadı.");
    const objects = await response.json();
    if (request !== targetRequest) return;
    const matches = objects.filter(item => item.id.startsWith(currentMode[0]));
    for (const item of matches) {
      const [x, y, right, bottom] = item.box;
      if (!(right > x && bottom > y)) continue;
      const button = document.createElement("button");
      button.className = "target";
      button.title = item.note !== undefined ? "Notu oku" : item.text || "Görseli düzenle";
      button.setAttribute("aria-label", button.title);
      Object.assign(button.style, {
        left: `${x * 100}%`, top: `${y * 100}%`,
        width: `${(right - x) * 100}%`, height: `${(bottom - y) * 100}%`
      });
      button.addEventListener("click", event => {
        event.stopPropagation();
        if (busy) return;
        selectedId = item.id;
        if (item.note !== undefined) {
          get("noteContent").textContent = item.note;
          get("noteDialog").showModal();
        } else if (item.text !== undefined) {
          get("editable").value = item.text;
          get("textDialog").showModal();
          get("editable").select();
        } else get("imageDialog").showModal();
      });
      if (item.id.startsWith("i")) button.addEventListener("keydown", event => {
        if (event.key !== "Delete" || event.repeat || busy) return;
        event.preventDefault();
        edit("image", {id: item.id});
      });
      get("targets").append(button);
    }
    if (currentMode === "note") {
      notify("Not eklemek için sayfaya, okumak için mevcut nota tıklayın.");
      return;
    }
    notify(get("targets").childElementCount
      ? (currentMode === "text" ? "Düzenlemek için bir yazı parçası seçin." : "Düzenlemek için bir görsel seçin.")
      : "Bu sayfada düzenlenebilir öğe bulunamadı.");
  } catch (error) {
    if (request === targetRequest) notify(error.message, true);
  }
}

async function edit(action, extra = {}, name = "") {
  if (busy) return;
  busy = true;
  controls();
  setMode();
  notify("İşleniyor…");
  const priorPage = page;
  const priorOffset = frames.length ? get("workspace").getBoundingClientRect().top + 12 -
    frames[page].getBoundingClientRect().top : 0;
  try {
    const fields = typeof extra === "function" ? await extra() : extra;
    notify("PDF işleniyor…");
    const response = await fetch("/edit", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, page, ...fields })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    if (action === "open" || !count) {
      filename = name;
      page = 0;
    } else if (action === "blank" || action === "insert") page += 1;
    else if (action === "append") page = count;
    else if (action === "reorder") page = fields.to;
    count = result.count;
    page = Math.min(page, count - 1);
    canUndo = result.undo;
    canRedo = result.redo;
    selectedPages.clear();
    closeSearch();
    revision += 1;
    loadThumbnails();
    loadFrames(result.ratios);
    loadPage();
    scrollToPage(page === priorPage && action !== "open" ? Math.max(0, priorOffset) : 0);
    const message = { open: "PDF açıldı.", append: "PDF sayfaları sona eklendi.",
      insert: "PDF sayfaları eklendi." };
    notify(message[action] || "Değişiklik uygulandı.");
  } catch (error) {
    notify(error.message || "İşlem tamamlanamadı.", true);
  } finally {
    busy = false;
    controls();
  }
}

function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = () => reject(new Error("Dosya okunamadı."));
    reader.readAsDataURL(file);
  });
}

function pick(action) {
  fileAction = action;
  const input = get("pdfInput");
  input.multiple = action !== "open";
  input.value = "";
  input.click();
}

async function usePdfs(files, action) {
  if (!files.length || busy) return;
  const tokens = [];
  try {
    await edit(action, async () => {
      const sources = [];
      const selected = action === "open" ? files.slice(0, 1) : files;
      for (const file of selected) {
        notify(`${file.name} aktarılıyor…`);
        const token = await uploadFile(file);
        tokens.push(token);
        sources.push({ name: file.name, token });
      }
      return action === "open" ? { token: tokens[0] } : { files: sources, newDocument: !count };
    }, files.length > 1 && action !== "open" ? "Birleştirilen PDF" : files[0].name);
  } finally {
    if (tokens.length) await fetch("/discard", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tokens })
    }).catch(() => {});
  }
}

function uploadFile(file, report = notify) {
  return new Promise((resolve, reject) => {
    if (!file.size) {
      reject(new Error(`${file.name} boş.`));
      return;
    }
    const request = new XMLHttpRequest();
    request.open("POST", "/upload");
    request.responseType = "json";
    request.setRequestHeader("Content-Type", "application/octet-stream");
    request.upload.onprogress = event => {
      if (event.lengthComputable) report(`${file.name} aktarılıyor · %${Math.round(event.loaded / event.total * 100)}`);
    };
    request.onload = () => {
      if (request.status === 200 && request.response?.token) resolve(request.response.token);
      else reject(new Error(request.response?.error || `${file.name} aktarılamadı.`));
    };
    request.onerror = request.onabort = () => reject(new Error(`${file.name} aktarılamadı.`));
    request.send(file);
  });
}

const conversionDialog = get("convertDialog");
const conversionKind = get("conversionKind");
const conversionFile = get("conversionFile");
const conversionHints = {
  "pdf-docx": "Metin düzenlenebilir olur. Karmaşık düzenler değişebilir ve taranmış sayfalar görsel olarak kalır.",
  "word-pdf": "Bu dönüşüm bilgisayarda yüklü Microsoft Word’ü kullanır.",
  "pdf-txt": "PDF’deki seçilebilir metni UTF-8 dosyası olarak kaydeder.",
  "pdf-png": "Her sayfayı bir PNG görseli olarak ZIP içinde kaydeder.",
  "pdf-jpeg": "Her sayfayı bir JPEG görseli olarak ZIP içinde kaydeder.",
  "images-pdf": "Bir veya daha fazla görsel seç. Her görsel PDF’de ayrı sayfa olur."
};

function conversionStatus(message = "", error = false) {
  const status = get("conversionStatus");
  status.textContent = message;
  status.classList.toggle("error", error);
}

function configureConversion() {
  const kind = conversionKind.value;
  const usesOpenPdf = kind.startsWith("pdf-") && count > 0;
  conversionFile.value = "";
  conversionFile.multiple = kind === "images-pdf";
  conversionFile.required = !usesOpenPdf;
  conversionFile.accept = kind === "images-pdf" ? ".png,.jpg,.jpeg" : kind === "word-pdf" ? ".doc,.docx" : ".pdf";
  get("conversionHint").textContent = conversionHints[kind] +
    (usesOpenPdf ? " Dosya seçmezsen açık PDF kullanılır." : "");
  conversionStatus();
}

get("openConvert").onclick = () => {
  configureConversion();
  conversionDialog.showModal();
};
get("closeConvert").onclick = () => conversionDialog.close();
conversionKind.onchange = configureConversion;
conversionDialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); });

get("convertForm").onsubmit = async event => {
  event.preventDefault();
  if (busy) return;
  const kind = conversionKind.value;
  const files = [...conversionFile.files];
  const inputs = [];
  const dialogControls = [conversionKind, conversionFile, get("closeConvert"), get("startConversion")];
  busy = true;
  controls();
  dialogControls.forEach(control => { control.disabled = true; });
  try {
    for (const file of files) inputs.push({name: file.name, token: await uploadFile(file, conversionStatus)});
    conversionStatus("Dosya dönüştürülüyor…");
    const response = await fetch("/convert", {method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({kind, inputs})});
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    const link = document.createElement("a");
    link.href = "/export/" + result.token;
    const name = files.length > 1 ? "Gorseller" : files[0]?.name || filename;
    link.download = name.replace(/\.[^.]+$/, "") + result.extension;
    link.click();
    conversionStatus("Dönüştürme tamamlandı. İndirme başlatıldı.");
  } catch (error) {
    conversionStatus(error.message || "Dönüştürme tamamlanamadı.", true);
  } finally {
    if (inputs.length) await fetch("/discard", {method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({tokens: inputs.map(input => input.token)})}).catch(() => {});
    busy = false;
    dialogControls.forEach(control => { control.disabled = false; });
    controls();
  }
};

get("open").onclick = get("choose").onclick = () => pick("open");
get("quickMerge").onclick = () => pick("append");
get("pdfInput").onchange = event => {
  const files = [...event.target.files];
  event.target.value = "";
  usePdfs(files, fileAction);
};
for (const button of actionButtons) button.onclick = () => {
  const action = button.dataset.action;
  if (action === "delete") {
    get("deleteMessage").textContent = `${pagesForAction().length} sayfa belgeden çıkarılacak.`;
    get("deleteDialog").showModal();
  } else if (action === "blank") edit(action);
  else pick(action);
};
for (const button of modeButtons) button.onclick = () => setMode(currentMode === button.dataset.mode ? "" : button.dataset.mode);
get("undo").onclick = () => edit("undo");
get("redo").onclick = () => edit("redo");
get("deleteDialog").onclose = event => { if (event.target.returnValue === "apply") edit("delete", {pages: pagesForAction()}); event.target.returnValue = ""; };
get("textDialog").onclose = event => {
  if (event.target.returnValue === "apply") edit("text", { id: selectedId, text: get("editable").value });
  event.target.returnValue = "";
};
get("imageDialog").onclose = event => {
  if (event.target.returnValue === "remove") edit("image", { id: selectedId });
  if (event.target.returnValue === "replace") get("imageInput").click();
  event.target.returnValue = "";
};
get("imageInput").onchange = async event => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  const id = selectedId;
  try { await edit("image", { id, data: await readFile(file) }); }
  catch (error) { notify(error.message, true); }
};
get("addImage").onclick = () => get("newImageInput").click();
get("newImageInput").onchange = event => {
  newImage = event.target.files[0] || null;
  event.target.value = "";
  if (newImage) setMode("add_image");
};
get("download").onclick = () => {
  const link = document.createElement("a");
  link.href = "/pdf";
  link.download = filename.replace(/\.pdf$/i, "") + "-duzenlendi.pdf";
  link.click();
};

const canvas = get("signature");
const context = canvas.getContext("2d");
let pointer = null;
function clearInk() {
  context.clearRect(0, 0, canvas.width, canvas.height);
  get("useInk").disabled = true;
}
function inkPoint(event) {
  const rect = canvas.getBoundingClientRect();
  return [(event.clientX - rect.left) * canvas.width / rect.width,
          (event.clientY - rect.top) * canvas.height / rect.height];
}
get("sign").onclick = () => {
  if (currentMode === "signature") return setMode();
  clearInk();
  get("signDialog").showModal();
};
get("clearInk").onclick = clearInk;
canvas.onpointerdown = event => {
  if (pointer !== null || event.button !== 0) return;
  pointer = event.pointerId;
  canvas.setPointerCapture(pointer);
  const [x, y] = inkPoint(event);
  context.strokeStyle = "#192a5e";
  context.lineWidth = 7;
  context.lineCap = "round";
  context.beginPath();
  context.moveTo(x, y);
  context.lineTo(x + 0.2, y);
  context.stroke();
  get("useInk").disabled = false;
};
canvas.onpointermove = event => {
  if (event.pointerId !== pointer) return;
  const [x, y] = inkPoint(event);
  context.lineTo(x, y);
  context.stroke();
  context.beginPath();
  context.moveTo(x, y);
};
canvas.onlostpointercapture = () => { pointer = null; };
get("signDialog").onclose = event => {
  if (event.target.returnValue === "apply") {
    signatureData = canvas.toDataURL("image/png").split(",")[1];
    setMode("signature");
  }
  event.target.returnValue = "";
};
get("sheet").onclick = event => {
  if (currentMode !== "signature") return;
  const rect = get("sheet").getBoundingClientRect();
  edit("signature", { x: (event.clientX - rect.left) / rect.width,
    y: (event.clientY - rect.top) / rect.height, data: signatureData });
};
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && !document.querySelector("dialog[open]")) setMode();
});
const workspace = get("workspace");
window.addEventListener("dragover", event => event.preventDefault());
window.addEventListener("drop", event => event.preventDefault());
workspace.addEventListener("dragover", () => workspace.classList.add("drag"));
workspace.addEventListener("dragleave", event => {
  if (!workspace.contains(event.relatedTarget)) workspace.classList.remove("drag");
});
workspace.addEventListener("drop", event => {
  workspace.classList.remove("drag");
  const files = [...event.dataTransfer.files];
  const picture = file => /^image\/(png|jpeg)$/i.test(file.type) || /\.(png|jpe?g)$/i.test(file.name);
  if (files.some(picture)) {
    if (busy) return;
    const frame = event.target.closest(".page-frame");
    if (files.length !== 1 || !frame || !count) {
      notify("Bir PNG veya JPEG dosyasını açık PDF’nin sayfasına bırakın.", true);
      return;
    }
    page = Number(frame.dataset.page);
    loadPage();
    placeImage(files[0], pagePoint(event, frame));
    return;
  }
  usePdfs(files, count || files.length > 1 ? "append" : "open");
});

function pagesForAction() {
  return selectedPages.size ? [...selectedPages].sort((a, b) => a - b) : [page];
}

function pageRanges(value) {
  const indices = new Set();
  for (const part of value.split(",")) {
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part.trim());
    if (!match) throw new Error("Sayfaları 1, 3-5 biçiminde girin.");
    const start = Number(match[1]);
    const end = Number(match[2] || start);
    if (start < 1 || end < start || end > count) throw new Error("Sayfa aralığı belgenin dışında.");
    for (let number = start; number <= end; number++) indices.add(number - 1);
  }
  return [...indices];
}

get("printPdf").onclick = () => {
  if (busy || !count) return;
  chooseOptions("PDF yazdır", [{
    name: "pages", label: "Sayfalar (ör. 1, 3-5)", value: count === 1 ? "1" : `1-${count}`
  }], "Yazdır", values => printPages(pageRanges(values.pages)));
};

async function printPages(pages) {
  busy = true;
  controls();
  const job = get("printJob");
  const rules = document.createElement("style");
  const finish = () => {
    job.replaceChildren();
    rules.remove();
    busy = false;
    controls();
    notify();
  };
  try {
    notify("Sayfalar yazdırmaya hazırlanıyor…");
    const response = await fetch("/print-info");
    if (!response.ok) throw new Error("PDF sayfa ölçüleri alınamadı.");
    const sizes = await response.json();
    const formats = new Map();
    for (let start = 0; start < pages.length; start += 4) {
      const sections = await Promise.all(pages.slice(start, start + 4).map(async index => {
        const [width, height] = sizes[index];
        const size = `${width.toFixed(3)}pt ${height.toFixed(3)}pt`;
        if (!formats.has(size)) formats.set(size, "pdf" + formats.size);
        const section = document.createElement("section");
        section.className = "print-page";
        section.style.page = formats.get(size);
        section.style.height = `${Math.max(1, height - .15)}pt`;
        const image = new Image();
        image.alt = `Sayfa ${index + 1}`;
        image.src = `/page/${index}/print?v=${revision}`;
        try { await image.decode(); }
        catch { throw new Error(`${index + 1}. sayfa yazdırmaya hazırlanamadı.`); }
        section.append(image);
        return section;
      }));
      job.append(...sections);
      notify(`Yazdırmaya hazırlanıyor · ${job.childElementCount} / ${pages.length}`);
    }
    rules.textContent = [...formats].map(([size, name]) => `@page ${name} { size: ${size}; margin: 0; }`).join("\n");
    document.head.append(rules);
    window.addEventListener("afterprint", finish, {once: true});
    window.print();
  } catch (error) {
    window.removeEventListener("afterprint", finish);
    finish();
    notify(error.message, true);
  }
}

function chooseOptions(title, fields, submit, callback) {
  const dialog = get("commandDialog");
  const area = get("commandFields");
  get("commandTitle").textContent = title;
  get("submitCommand").textContent = submit;
  area.replaceChildren();
  for (const field of fields) {
    const label = document.createElement("label");
    const input = document.createElement(field.options ? "select" : field.multiline ? "textarea" : "input");
    input.name = field.name;
    input.id = "field-" + field.name;
    label.htmlFor = input.id;
    label.textContent = field.label;
    if (field.options) {
      for (const [value, text] of field.options) input.add(new Option(text, value));
    } else if (!field.multiline) {
      input.type = field.type || "text";
      if (field.min !== undefined) input.min = field.min;
      if (field.max !== undefined) input.max = field.max;
    }
    input.required = true;
    input.value = field.value ?? input.value;
    input.maxLength = 2000;
    area.append(label, input);
  }
  dialog.querySelector("form").onsubmit = event => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.target));
    dialog.close();
    try { callback(values); }
    catch (error) { notify(error.message, true); }
  };
  dialog.showModal();
}

get("cancelCommand").onclick = () => get("commandDialog").close();
function changeZoom(level, anchor) {
  if (busy || !count || zoom === level) return;
  const container = get("workspace");
  const bounds = frames[page].getBoundingClientRect();
  const view = container.getBoundingClientRect();
  const x = anchor?.clientX ?? (view.left + view.width / 2);
  const y = anchor?.clientY ?? (view.top + view.height / 3);
  const relativeX = (x - bounds.left) / bounds.width;
  const relativeY = (y - bounds.top) / bounds.height;
  zoom = level;
  get("zoom").value = level;
  resizeStack();
  const resized = frames[page].getBoundingClientRect();
  automaticScroll = true;
  container.scrollLeft += resized.left + relativeX * resized.width - x;
  container.scrollTop += resized.top + relativeY * resized.height - y;
  requestAnimationFrame(() => requestAnimationFrame(() => { automaticScroll = false; }));
  controls();
}

function stepZoom(direction, anchor) {
  const level = zoomLevels[Math.max(0, Math.min(zoomLevels.length - 1, zoomLevels.indexOf(zoom) + direction))];
  changeZoom(level, anchor);
}

get("zoom").onchange = event => changeZoom(event.target.value);
get("zoomOut").onclick = () => stepZoom(-1);
get("zoomIn").onclick = () => stepZoom(1);
let lastZoomWheel = -Infinity;
get("workspace").addEventListener("wheel", event => {
  if (!(event.ctrlKey || event.metaKey) || !count) return;
  event.preventDefault();
  if (event.timeStamp - lastZoomWheel < 100 || !event.deltaY) return;
  lastZoomWheel = event.timeStamp;
  stepZoom(event.deltaY < 0 ? 1 : -1, event);
}, {passive: false});

get("pagePosition").onclick = () => chooseOptions("Sayfaya git", [
  {name: "number", label: "Sayfa numarası", type: "number", min: 1, max: count, value: page + 1}
], "Git", values => navigate(Number(values.number) - 1));

get("rotate").onclick = () => chooseOptions("Sayfaları döndür", [
  {name: "angle", label: `${pagesForAction().length} sayfa için yön`,
    options: [["90", "90° saat yönünde"], ["-90", "90° saat yönünün tersine"], ["180", "180°"]]}
], "Döndür", values => edit("rotate", {angle: Number(values.angle), pages: pagesForAction()}));

get("compress").onclick = () => chooseOptions("PDF sıkıştır", [
  {name: "quality", label: "Görsel kalitesi", value: "medium",
    options: [["high", "Yüksek · 200 dpi"], ["medium", "Dengeli · 150 dpi"], ["low", "Küçük dosya · 96 dpi"]]}
], "Sıkıştır", values => edit("compress", values));

get("ocr").onclick = () => chooseOptions("OCR · Türkçe ve İngilizce", [
  {name: "scope", label: "Taranacak sayfalar", options: [
    ["selected", selectedPages.size ? `Seçili ${selectedPages.size} sayfa` : "Geçerli sayfa"], ["all", "Tüm belge"]]}
], "Metni tanı", values => edit("ocr", {
  pages: values.scope === "all" ? Array.from({length: count}, (_, index) => index) : pagesForAction()
}));

async function exportPages(groups) {
  if (busy) return;
  busy = true;
  controls();
  notify("Dosya hazırlanıyor…");
  try {
    const response = await fetch("/export", {method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({groups})});
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    const link = document.createElement("a");
    link.href = "/export/" + result.token;
    link.download = filename.replace(/\.pdf$/i, "") + "-sayfalar." + result.extension;
    link.click();
    notify("Dosya hazır.");
  } catch (error) {
    notify(error.message, true);
  } finally {
    busy = false;
    controls();
  }
}

get("extract").onclick = () => chooseOptions("Sayfaları ayrı PDF olarak çıkar", [
  {name: "pages", label: "Sayfalar (ör. 1, 3-5)", value: pagesForAction().map(n => n + 1).join(", ")}
], "PDF indir", values => exportPages([pageRanges(values.pages)]));

get("split").onclick = () => chooseOptions("PDF böl", [
  {name: "parts", label: "Bölümleri / ile ayırın (ör. 1-3 / 4-6)",
    value: count > 1 ? `1-${Math.ceil(count / 2)} / ${Math.ceil(count / 2) + 1}-${count}` : ""}
], "ZIP indir", values => {
  const groups = values.parts.split("/").map(pageRanges);
  if (groups.length < 2) throw new Error("En az iki bölüm girin.");
  exportPages(groups);
});

function closeSearch() {
  matches = [];
  get("searchNav").hidden = true;
  get("searchMarks").replaceChildren();
}

function paintSearch() {
  const layer = get("searchMarks");
  layer.replaceChildren();
  for (const [index, result] of matches.entries()) {
    if (result.page !== page) continue;
    const marker = document.createElement("div");
    marker.className = index === matchIndex ? "active-match" : "match";
    const [x, y, right, bottom] = result.box;
    Object.assign(marker.style, {left: x * 100 + "%", top: y * 100 + "%",
      width: (right - x) * 100 + "%", height: (bottom - y) * 100 + "%"});
    layer.append(marker);
  }
}

function moveMatch(index) {
  if (!matches.length || busy) return;
  matchIndex = (index + matches.length) % matches.length;
  navigate(matches[matchIndex].page);
  get("matchPosition").textContent = `${matchIndex + 1} / ${matches.length}`;
  const target = get("searchMarks").querySelector(".active-match");
  const image = get("pageImage");
  const reveal = () => target?.scrollIntoView({block: "center", inline: "nearest"});
  if (image.complete) reveal();
  else image.addEventListener("load", reveal, {once: true});
}

get("previousMatch").onclick = () => moveMatch(matchIndex - 1);
get("nextMatch").onclick = () => moveMatch(matchIndex + 1);
get("closeSearch").onclick = closeSearch;

async function searchDocument(query) {
  if (busy || !query.trim()) return;
  closeSearch();
  busy = true;
  controls();
  setMode();
  notify("Belge aranıyor…");
  try {
    const response = await fetch("/search?q=" + encodeURIComponent(query.slice(0, 200)));
    if (!response.ok) throw new Error("Belge aranamadı.");
    matches = await response.json();
    notify(matches.length ? `${matches.length} sonuç bulundu.` : "Sonuç bulunamadı.");
  } catch (error) {
    notify(error.message, true);
  } finally {
    busy = false;
    controls();
  }
  if (matches.length) {
    get("searchNav").hidden = false;
    moveMatch(0);
  }
}

get("find").onclick = () => chooseOptions("Belgede ara", [
  {name: "query", label: "Aranacak metin"}
], "Ara", values => searchDocument(values.query));

function pagePoint(event, element = get("sheet")) {
  const rect = element.getBoundingClientRect();
  const norm = value => Math.max(0, Math.min(1, value));
  return [norm((event.clientX - rect.left) / rect.width), norm((event.clientY - rect.top) / rect.height)];
}

const sheet = get("sheet");
const preview = get("areaPreview");
const placementBox = get("imagePlacement");
const placementImage = placementBox.querySelector("img");
const limit = (value, low, high) => Math.max(low, Math.min(high, value));

function cancelPlacement() {
  if (!placement) return;
  URL.revokeObjectURL(placement.url);
  placement = null;
  placementImage.removeAttribute("src");
  placementBox.hidden = true;
  get("imagePlacementActions").hidden = true;
}

function paintPlacement() {
  const {x, y, width, ratio} = placement;
  Object.assign(placementBox.style, {left: x * 100 + "%", top: y * 100 + "%",
    width: width * 100 + "%", height: width * ratio * 100 + "%"});
  get("placementSize").value = (width * 100).toFixed(1);
}

async function placeImage(file, point) {
  setMode();
  const draft = {file, url: URL.createObjectURL(file), page};
  placement = draft;
  placementImage.src = draft.url;
  try {
    await placementImage.decode();
    if (placement !== draft) return;
    const bounds = sheet.getBoundingClientRect();
    const ratio = bounds.width / bounds.height * placementImage.naturalHeight / placementImage.naturalWidth;
    const width = Math.min(.3, 1 / ratio);
    Object.assign(draft, {ratio, width, x: limit(point[0] - width / 2, 0, 1 - width),
      y: limit(point[1] - width * ratio / 2, 0, 1 - width * ratio)});
    placementBox.hidden = false;
    get("imagePlacementActions").hidden = false;
    paintPlacement();
    notify("Enter ile ekle · Esc veya Delete ile kaldır");
  } catch {
    if (placement === draft) {
      cancelPlacement();
      notify("Görsel açılamadı. Geçerli bir PNG veya JPEG seçin.", true);
    }
  }
}

function sizePlacement(width) {
  const maximum = Math.min(1 - placement.x, (1 - placement.y) / placement.ratio);
  placement.width = limit(width, Math.min(.01, maximum), maximum);
  paintPlacement();
}

get("placementSize").step = "0.1";
get("placementSize").onchange = event => {
  if (placement) sizePlacement(Number(event.target.value) / 100 || placement.width);
};
get("cancelPlacement").onclick = () => { cancelPlacement(); notify(); };
get("applyPlacement").onclick = () => {
  if (!placement || placement.page !== page) return;
  const {file, x, y, width, ratio} = placement;
  const point = [x + width / 2, y + width * ratio / 2];
  edit("add_image", async () => ({point, size: width * 100, data: await readFile(file)}));
};

document.addEventListener("keydown", event => {
  if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey || busy) return;
  if (event.key === "Delete" && get("imageDialog").open) {
    event.preventDefault();
    if (!event.repeat) get("imageDialog").close("remove");
    return;
  }
  if (!placement || placementBox.hidden || document.querySelector("dialog[open]")) return;
  if (event.key === "Enter" && event.target !== get("cancelPlacement")) {
    event.preventDefault();
    if (event.repeat) return;
    const sizeInput = get("placementSize");
    if (event.target === sizeInput) sizePlacement(Number(sizeInput.value) / 100 || placement.width);
    get("applyPlacement").click();
    return;
  }
  if (event.target.closest("input, textarea, select, [contenteditable=true]")) return;
  if (event.key === "Delete") {
    event.preventDefault();
    get("cancelPlacement").click();
    return;
  }
  const direction = {ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1]}[event.key];
  if (!direction) return;
  event.preventDefault();
  const box = sheet.getBoundingClientRect();
  const distance = event.shiftKey ? 12 : 2;
  placement.x = limit(placement.x + distance * direction[0] / box.width, 0, 1 - placement.width);
  placement.y = limit(placement.y + distance * direction[1] / box.height, 0, 1 - placement.width * placement.ratio);
  paintPlacement();
});

let placementDrag = null;
placementBox.onpointerdown = event => {
  if (!placement || event.button !== 0) return;
  event.stopPropagation();
  const {x, y, width} = placement;
  placementDrag = {x, y, width, start: pagePoint(event), resize: event.target.id === "resizePlacement"};
  placementBox.setPointerCapture(event.pointerId);
};
placementBox.onpointermove = event => {
  if (!placement || !placementDrag) return;
  const [x, y] = pagePoint(event);
  const drag = placementDrag;
  const dx = x - drag.start[0];
  const dy = y - drag.start[1];
  if (drag.resize) {
    sizePlacement(drag.width + (dx + dy * placement.ratio) / (1 + placement.ratio ** 2));
  } else {
    placement.x = limit(drag.x + dx, 0, 1 - placement.width);
    placement.y = limit(drag.y + dy, 0, 1 - placement.width * placement.ratio);
    paintPlacement();
  }
};
placementBox.onlostpointercapture = () => { placementDrag = null; };
let selectionStart = null;
sheet.addEventListener("pointerdown", event => {
  if (busy || event.button !== 0 || !areaModes.includes(currentMode)) return;
  selectionStart = pagePoint(event);
  sheet.setPointerCapture(event.pointerId);
  preview.style.width = "0";
  preview.style.height = "0";
  preview.hidden = false;
});
sheet.addEventListener("pointermove", event => {
  if (!selectionStart) return;
  const [x, y] = pagePoint(event);
  const [startX, startY] = selectionStart;
  Object.assign(preview.style, {left: Math.min(x, startX) * 100 + "%", top: Math.min(y, startY) * 100 + "%",
    width: Math.abs(x - startX) * 100 + "%", height: Math.abs(y - startY) * 100 + "%"});
});
sheet.addEventListener("pointercancel", () => {
  selectionStart = null;
  preview.hidden = true;
});
sheet.addEventListener("pointerup", event => {
  if (!selectionStart) return;
  const point = selectionStart;
  const end = pagePoint(event);
  selectionStart = null;
  preview.hidden = true;
  if (Math.abs(end[0] - point[0]) < 0.003 || Math.abs(end[1] - point[1]) < 0.003) return;
  const mode = currentMode;
  if (mode === "redact") {
    chooseOptions("Seçili alan kalıcı olarak kaldırılsın mı?", [], "Kalıcı karart", () => edit(mode, {point, end}));
  } else if (areaModes.includes(mode)) edit(mode, {point, end});
});

sheet.addEventListener("click", event => {
  const mode = currentMode;
  if (busy || !["note", "add_text", "add_image"].includes(mode)) return;
  const point = pagePoint(event);
  if (mode === "add_image") {
    placeImage(newImage, point);
    return;
  }
  const fields = [{name: "text", label: mode === "note" ? "Not" : "Metin", multiline: true}];
  if (mode === "add_text") fields.push({name: "size", label: "Yazı boyutu (pt)", type: "number", min: 6, max: 96, value: 12});
  chooseOptions(mode === "note" ? "Not ekle" : "Metin kutusu", fields, "Ekle",
    values => edit(mode, {...values, point}));
});

document.addEventListener("keydown", event => {
  if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "p") {
    event.preventDefault();
    if (!event.repeat && !document.querySelector("dialog[open]")) get("printPdf").click();
    return;
  }
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.isComposing || !count || busy ||
      document.querySelector("dialog[open]") ||
      event.target.closest("input, textarea, select, [contenteditable=true]")) return;
  const key = event.key.toLowerCase();
  const button = {f: "find", y: "redo", z: event.shiftKey ? "redo" : "undo"}[key];
  if (!button) return;
  event.preventDefault();
  if (!event.repeat) get(button).click();
});
const updateDialog = get("updateDialog");
const updateProgress = get("updateProgress");
const installButton = get("installUpdate");
const cancelUpdate = get("cancelUpdate");
let offeredUpdate = null;

function updateMessage(message, percent = null) {
  get("updateStatus").textContent = message;
  updateProgress.hidden = percent === null;
  if (percent !== null) updateProgress.value = percent;
}

async function loadUpdateOffer() {
  try {
    const response = await fetch("/update");
    if (!response.ok) return;
    const {available, installable} = await response.json();
    if (!available) return;
    offeredUpdate = available;
    const canInstall = installable && Boolean(available.sha256);
    const link = get("updateLink");
    link.href = available.url;
    link.textContent = `Yeni sürüm · ${available.version}`;
    link.hidden = canInstall;
    const button = get("updateButton");
    button.textContent = `Güncelle · ${available.version}`;
    button.hidden = !canInstall;
  } catch {
    // Keep the editor available offline.
  }
}

async function watchInstallation() {
  for (;;) {
    await new Promise(resolve => setTimeout(resolve, 500));
    const response = await fetch("/update");
    if (!response.ok) throw new Error("Güncelleme durumu alınamadı.");
    const {status} = await response.json();
    if (status.phase === "error") throw new Error(status.message);
    if (status.phase === "installed") {
      updateMessage("Güncelleme tamamlandı. Yeni sürüm ayrı bir sekmede açılıyor.");
      return;
    }
    if (status.phase === "install") updateMessage("Doğrulandı. Windows kurulumu yapılıyor…");
    else updateMessage("Güncelleme indiriliyor…", status.percent ?? 0);
  }
}

get("updateButton").onclick = () => {
  installButton.disabled = false;
  updateMessage(`${offeredUpdate.version} sürümü indirilecek ve TugbayReader yeniden açılacak.`);
  updateDialog.showModal();
};
cancelUpdate.onclick = () => updateDialog.close();
updateDialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
installButton.onclick = async () => {
  if (busy || !offeredUpdate) return;
  if (placement) return updateMessage("Önce görsel yerleştirmeyi tamamla veya iptal et.");
  busy = true;
  controls();
  installButton.disabled = cancelUpdate.disabled = true;
  let installed = false;
  try {
    const response = await fetch("/update/install", {method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({version: offeredUpdate.version})});
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    updateMessage("Güncelleme indiriliyor…", 0);
    await watchInstallation();
    installed = true;
  } catch (error) {
    updateMessage(error.message || "Güncelleme tamamlanamadı.");
  } finally {
    cancelUpdate.disabled = false;
    if (!installed) {
      busy = false;
      installButton.disabled = false;
      controls();
    }
  }
};

controls();
if (location.protocol === "file:") {
  for (const element of document.body.children) element.hidden = true;
  get("launchHelp").hidden = false;
} else {
  fetch("/startup").then(response => response.json()).then(state => {
    if (busy || count) return;
    if (state.error) {
      notify(state.error, true);
      return;
    }
    if (!state.count) return;
    filename = state.name;
    count = state.count;
    canUndo = state.undo;
    canRedo = state.redo;
    loadThumbnails();
    loadFrames(state.ratios);
    loadPage();
  }).catch(() => {});
  window.setTimeout(loadUpdateOffer, 5000);
}
