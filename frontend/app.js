const WORKER_URL = "https://edu-live-worker.naveed-ks.workers.dev";

const THEME_STORAGE_KEY = "edukripa-theme";
const themeToggle = document.getElementById("theme-toggle");

function currentTheme() {
  return document.documentElement.getAttribute("data-theme") || "auto";
}

themeToggle.addEventListener("click", () => {
  const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  const isDark = currentTheme() === "dark" || (currentTheme() === "auto" && prefersDark);
  const next = isDark ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch (e) {}
});

const chatForm = document.getElementById("chat-form");
const questionInput = document.getElementById("question-input");
const answerStyleSelect = document.getElementById("answer-style-select");
const chatLog = document.getElementById("chat-log");

const THINKING_PHRASES = ["Thinking", "Searching your notes", "Checking sources", "Composing an answer"];

const modeButtons = document.querySelectorAll(".mode-btn");
const sectionTitle = document.getElementById("chat-section-title");
const questionPaperPanel = document.getElementById("question-paper-panel");
const qpSubjectSelect = document.getElementById("qp-subject-select");
const qpClassSelect = document.getElementById("qp-class-select");
const qpChapterList = document.getElementById("qp-chapter-list");
const qpMarksSelect = document.getElementById("qp-marks-select");
const qpGenerateBtn = document.getElementById("qp-generate-btn");
const qpResult = document.getElementById("qp-result");

let qpCatalog = [];
let qpCatalogLoading = false;

// Question-paper content comes from an LLM/RAG pipeline and catalog values
// from upload metadata - escape before every innerHTML interpolation.
function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function loadQuestionPaperCatalog() {
  if (qpCatalog.length > 0 || qpCatalogLoading) return;
  qpCatalogLoading = true;
  try {
    const response = await fetch(`${WORKER_URL}/question-paper/catalog`);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      qpResult.textContent = `Could not load chapters: ${body.error ?? `server error (${response.status})`}`;
      return;
    }
    qpCatalog = body.documents || [];
    if (qpCatalog.length === 0) {
      qpResult.textContent = "No chapters are available for question papers yet.";
    }

    const subjects = [...new Set(qpCatalog.map((d) => d.subject))];
    qpSubjectSelect.innerHTML = subjects
      .map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`)
      .join("");
    renderClassOptions();
  } catch (err) {
    qpResult.textContent = `Could not load chapters - could not reach the server (${err.message}). Switch tabs to retry.`;
  } finally {
    qpCatalogLoading = false;
  }
}

function renderClassOptions() {
  const subject = qpSubjectSelect.value;
  const classes = [...new Set(qpCatalog.filter((d) => d.subject === subject).map((d) => d.class))];
  qpClassSelect.innerHTML = classes
    .map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`)
    .join("");
  renderChapterCheckboxes();
}

function renderChapterCheckboxes() {
  const subject = qpSubjectSelect.value;
  const cls = qpClassSelect.value;
  const chapters = qpCatalog.filter((d) => d.subject === subject && d.class === cls);
  qpChapterList.innerHTML =
    "<legend>Chapters</legend>" +
    chapters
      .map(
        (c) =>
          `<label><input type="checkbox" value="${escapeHtml(c.filename)}" /> ${escapeHtml(c.chapter)}</label>`
      )
      .join("");
}

qpSubjectSelect.addEventListener("change", renderClassOptions);
qpClassSelect.addEventListener("change", renderChapterCheckboxes);

qpGenerateBtn.addEventListener("click", async () => {
  const chapterFilenames = [...qpChapterList.querySelectorAll("input:checked")].map((el) => el.value);
  if (chapterFilenames.length === 0) {
    qpResult.textContent = "Select at least one chapter.";
    return;
  }

  // In-flight guard: a double-click would otherwise fire two requests and
  // whichever landed last (possibly an error) would overwrite the display.
  if (qpGenerateBtn.disabled) return;
  qpGenerateBtn.disabled = true;
  const originalLabel = qpGenerateBtn.textContent;
  qpGenerateBtn.textContent = "Generating...";
  qpResult.textContent = "Generating...";
  try {
    const response = await fetch(`${WORKER_URL}/question-paper/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subject: qpSubjectSelect.value,
        class: qpClassSelect.value,
        chapterFilenames,
        marksTotal: Number(qpMarksSelect.value),
      }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      qpResult.textContent = body.error || `Something went wrong (${response.status}). Please try again.`;
      return;
    }

    const body = await response.json();
    renderQuestionPaper(body.id, body.paper);
  } catch (err) {
    qpResult.textContent = `Could not generate the question paper - could not reach the server (${err.message}).`;
  } finally {
    qpGenerateBtn.disabled = false;
    qpGenerateBtn.textContent = originalLabel;
  }
});

function renderQuestionTable(table) {
  if (!table || !Array.isArray(table.headers) || !Array.isArray(table.rows)) return "";
  const head = `<tr>${table.headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr>`;
  const body = table.rows
    .map((row) => `<tr>${(Array.isArray(row) ? row : []).map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`)
    .join("");
  return `<table class="qp-table"><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

function renderQuestionItem(q) {
  const imageKey = q.pageImageKey || q.generatedImageKey;
  const image = imageKey
    ? `<img src="${WORKER_URL}/images/${encodeURIComponent(imageKey)}" alt="diagram" />`
    : "";
  const latex = q.latex ? `<pre class="qp-latex">${escapeHtml(q.latex)}</pre>` : "";
  const marks = Number(q.marks);
  return (
    `<li>${escapeHtml(q.text)} <em>[${escapeHtml(q.marks)} mark${marks === 1 ? "" : "s"}]</em>` +
    `${latex}${renderQuestionTable(q.table)}${image}</li>`
  );
}

function renderQuestionPaper(paperId, paper) {
  const sectionsHtml = paper.sections
    .map((s) => `<h3>Section ${escapeHtml(s.section)}</h3><ol>${s.questions.map(renderQuestionItem).join("")}</ol>`)
    .join("");

  const encodedId = encodeURIComponent(paperId);
  qpResult.innerHTML =
    `<div class="qp-actions">` +
    `<a href="${WORKER_URL}/question-paper/${encodedId}/pdf" target="_blank">Download PDF</a>` +
    `<button type="button" id="qp-answer-key-btn">Generate Answer Key</button>` +
    `</div>${sectionsHtml}<div id="qp-answer-key-result"></div>`;

  const answerKeyBtn = document.getElementById("qp-answer-key-btn");
  answerKeyBtn.addEventListener("click", async () => {
    if (answerKeyBtn.disabled) return;
    const akResult = document.getElementById("qp-answer-key-result");
    answerKeyBtn.disabled = true;
    const originalLabel = answerKeyBtn.textContent;
    answerKeyBtn.textContent = "Generating answer key...";
    akResult.textContent = "Generating answer key...";
    try {
      const response = await fetch(`${WORKER_URL}/question-paper/${encodedId}/answer-key`, { method: "POST" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !Array.isArray(body.answerKey?.entries)) {
        akResult.textContent = body.error || "Could not generate the answer key. Please try again.";
        return;
      }
      akResult.innerHTML =
        `<h3>Answer Key</h3><ol>${body.answerKey.entries.map((e) => `<li>${escapeHtml(e.answer)}</li>`).join("")}</ol>` +
        `<a href="${WORKER_URL}/question-paper/${encodedId}/answer-key-pdf" target="_blank">Download Answer Key PDF</a>`;
    } catch (err) {
      akResult.textContent = `Could not generate the answer key - could not reach the server (${err.message}).`;
    } finally {
      answerKeyBtn.disabled = false;
      answerKeyBtn.textContent = originalLabel;
    }
  });
}

let currentMode = "chat";

const MODE_COPY = {
  chat: { title: "Ask a question", placeholder: "Ask a science or maths question..." },
  explain: { title: "Explain a concept", placeholder: "Enter a concept, e.g. Newton's second law" },
  questionPaper: { title: "Question Paper", placeholder: "" },
};

modeButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    currentMode = btn.dataset.mode;
    modeButtons.forEach((b) => {
      b.classList.toggle("active", b === btn);
      b.setAttribute("aria-selected", String(b === btn));
    });
    sectionTitle.textContent = MODE_COPY[currentMode].title;
    questionInput.placeholder = MODE_COPY[currentMode].placeholder;
    answerStyleSelect.style.display = currentMode === "chat" ? "" : "none";

    const isQuestionPaper = currentMode === "questionPaper";
    questionPaperPanel.hidden = !isQuestionPaper;
    chatLog.hidden = isQuestionPaper;
    chatForm.hidden = isQuestionPaper;
    if (isQuestionPaper) loadQuestionPaperCatalog();
  });
});

chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const question = questionInput.value.trim();
  if (!question) return;

  appendMessage("user", question);
  questionInput.value = "";
  const submitBtn = chatForm.querySelector("button[type=submit]");
  submitBtn.disabled = true;

  const thinkingEl = appendMessage("assistant", `${THINKING_PHRASES[0]}...`, { thinking: true });
  let phraseIndex = 0;
  const timer = setInterval(() => {
    phraseIndex = (phraseIndex + 1) % THINKING_PHRASES.length;
    thinkingEl.textContent = `${THINKING_PHRASES[phraseIndex]}...`;
  }, 1200);

  try {
    if (currentMode === "chat") {
      const response = await fetch(`${WORKER_URL}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, answerStyle: answerStyleSelect.value }),
      });
      const result = await response.json();

      thinkingEl.classList.remove("thinking");
      thinkingEl.textContent = result.answer ?? `Error: ${result.error}`;

      const imageKeys = (result.docSources ?? [])
        .map((s) => s.pageImageKey)
        .filter((key, index, all) => key && all.indexOf(key) === index); // dedupe, drop nulls

      for (const key of imageKeys) {
        const img = document.createElement("img");
        img.src = `${WORKER_URL}/images/${encodeURIComponent(key)}`;
        img.className = "answer-source-image";
        img.alt = "Source page image";
        thinkingEl.appendChild(document.createElement("br"));
        thinkingEl.appendChild(img);
      }
    } else {
      const response = await fetch(`${WORKER_URL}/explain`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ concept: question }),
      });
      const result = await response.json();

      thinkingEl.classList.remove("thinking");

      if (!response.ok) {
        // A guardrail refusal (e.g. the age-inappropriate/temporarily-unable
        // message) comes back as simpleExplanation, not error - show that
        // directly rather than falling through to a generic error string.
        thinkingEl.textContent =
          response.status === 404
            ? "Concept Explainer isn't available right now."
            : result.simpleExplanation || `Error: ${result.error ?? "something went wrong"}`;
      } else {
        renderExplanation(thinkingEl, result);
      }
    }
  } catch (err) {
    thinkingEl.classList.remove("thinking");
    thinkingEl.textContent = `Error: could not reach the server (${err.message})`;
  } finally {
    clearInterval(timer);
    submitBtn.disabled = false;
  }
});

function renderExplanation(container, result) {
  container.textContent = "";

  const addSection = (heading, contentEl) => {
    const section = document.createElement("div");
    section.className = "explain-section";
    if (heading) {
      const h = document.createElement("strong");
      h.textContent = heading;
      section.appendChild(h);
    }
    section.appendChild(contentEl);
    container.appendChild(section);
  };

  const simple = document.createElement("p");
  simple.textContent = result.simpleExplanation;
  addSection(null, simple);

  if (Array.isArray(result.steps) && result.steps.length > 0) {
    const ol = document.createElement("ol");
    result.steps.forEach((step) => {
      const li = document.createElement("li");
      li.textContent = step;
      ol.appendChild(li);
    });
    addSection("Steps", ol);
  }

  if (result.formula || result.definition) {
    const box = document.createElement("div");
    box.className = "formula-box";
    if (result.formula) {
      const f = document.createElement("p");
      f.className = "formula-text";
      f.textContent = result.formula;
      box.appendChild(f);
    }
    if (result.definition) {
      const d = document.createElement("p");
      d.textContent = result.definition;
      box.appendChild(d);
    }
    addSection("Formula & Definition", box);
  }

  if (result.table && Array.isArray(result.table.headers) && Array.isArray(result.table.rows)) {
    const table = document.createElement("table");
    table.className = "explain-table";
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    result.table.headers.forEach((h) => {
      const th = document.createElement("th");
      th.textContent = h;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    result.table.rows.forEach((row) => {
      const tr = document.createElement("tr");
      row.forEach((cell) => {
        const td = document.createElement("td");
        td.textContent = cell;
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    addSection("Table", table);
  }

  if (result.realWorldExample) {
    const ex = document.createElement("p");
    ex.textContent = result.realWorldExample;
    addSection("Real-world example", ex);
  }

  if (result.pageImageKey) {
    const img = document.createElement("img");
    img.src = `${WORKER_URL}/images/${encodeURIComponent(result.pageImageKey)}`;
    img.className = "answer-source-image";
    img.alt = "Source page image";
    addSection(null, img);
  }

  if (result.videoSearchUrl) {
    const link = document.createElement("a");
    link.href = result.videoSearchUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Watch a video about this concept";
    addSection(null, link);
  }
}

function appendMessage(role, text, { thinking = false } = {}) {
  const el = document.createElement("div");
  el.className = `message ${role}${thinking ? " thinking" : ""}`;
  el.textContent = text;
  chatLog.appendChild(el);
  chatLog.scrollTop = chatLog.scrollHeight;
  return el;
}
