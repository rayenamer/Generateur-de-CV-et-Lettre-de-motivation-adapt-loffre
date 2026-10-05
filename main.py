import os
import re
import subprocess
import tempfile
from typing import Any, Dict, List
from urllib.parse import quote

from fastapi import Body, FastAPI, HTTPException, Response

app = FastAPI()

# Identity comes from .env (used as fallback for the resume, and for the cover letter)
ENV = {k: os.getenv(k, "") for k in
       ["CV_NAME", "CV_LOCATION", "CV_EMAIL", "CV_PHONE", "CV_GITHUB", "CV_LINKEDIN"]}


# ================================================================ escaping ===
_UNESCAPE = [
    (r"\textbackslash{}", "\\"), (r"\textasciitilde{}", "~"), (r"\textasciicircum{}", "^"),
    (r"\&", "&"), (r"\%", "%"), (r"\$", "$"), (r"\#", "#"), (r"\_", "_"), (r"\{", "{"), (r"\}", "}"),
]
_TEX_MAP = {
    "\\": r"\textbackslash{}", "%": r"\%", "&": r"\&", "_": r"\_", "#": r"\#",
    "$": r"\$", "{": r"\{", "}": r"\}", "~": r"\textasciitilde{}", "^": r"\textasciicircum{}",
}
_TEX_RE = re.compile(r"[\\%&_#${}~^]")


def raw(text: Any) -> str:
    """Undo any LaTeX escaping already applied upstream (n8n), so we never double-escape."""
    if text is None:
        return ""
    text = str(text)
    for esc, ch in _UNESCAPE:
        text = text.replace(esc, ch)
    return text.strip()


def tex(text: Any) -> str:
    """Escape plain text for LaTeX exactly once (safe for raw or pre-escaped input)."""
    return _TEX_RE.sub(lambda m: _TEX_MAP[m.group()], raw(text))


def tex_url(url: str) -> str:
    url = re.sub(r"[\s\\{}]", "", raw(url))
    return url.replace("%", r"\%").replace("#", r"\#")


def clean_keys(obj: Any) -> Any:
    """Normalise keys like 'PROFILE\\_SUMMARY' back to 'PROFILE_SUMMARY'."""
    if isinstance(obj, dict):
        return {raw(k): clean_keys(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [clean_keys(v) for v in obj]
    return obj


def first(d: dict, *keys, default=""):
    for k in keys:
        v = d.get(k)
        if v not in (None, "", [], {}):
            return v
    return default


def as_list(v: Any) -> List[str]:
    if v is None:
        return []
    if isinstance(v, str):
        return [v] if v.strip() else []
    if isinstance(v, list):
        out = []
        for x in v:
            if isinstance(x, dict):
                x = first(x, "name", "title", "label", "value")
            if x and str(x).strip():
                out.append(str(x))
        return out
    return [str(v)]


def is_english(text: str) -> bool:
    t = " " + raw(text).lower() + " "
    fr = len(re.findall(r"[éèêàùçôî]", t)) + sum(t.count(w) for w in [" le ", " la ", " les ", " des ", " et ", " du "])
    en = sum(t.count(w) for w in [" the ", " and ", " of ", " with ", " for ", " in "])
    return en > fr


# ================================================================ helpers ===
def github_link(value: str) -> str:
    value = raw(value)
    if not value:
        return ""
    label = re.sub(r"^https?://", "", value)
    if "github.com" not in label:
        label = f"github.com/{label}"
    return rf"\href{{https://{tex_url(label)}}}{{{tex(label)}}}"


def linkedin_link(value: str) -> str:
    value = raw(value)
    if not value:
        return ""
    if "linkedin.com" in value:
        label = re.sub(r"^https?://", "", value)
        return rf"\href{{https://{tex_url(label)}}}{{{tex(label)}}}"
    return "LinkedIn : " + tex(value)


def contact_line(location="", email="", phone="", github="", linkedin="") -> str:
    parts = []
    if raw(location):
        parts.append(tex(location))
    if raw(email):
        parts.append(rf"\href{{mailto:{tex_url(email)}}}{{{tex(email)}}}")
    if raw(phone):
        parts.append(tex(phone))
    if raw(github):
        parts.append(github_link(github))
    if raw(linkedin):
        parts.append(linkedin_link(linkedin))
    return r" ~$\diamond$~ ".join(parts)


def itemize(items: List[str]) -> str:
    items = [i for i in items if raw(i)]
    if not items:
        return ""
    return "\\begin{itemize}\n" + "\n".join(rf"  \item {tex(i)}" for i in items) + "\n\\end{itemize}"


def two_col(left: str, right: str) -> str:
    return rf"{left} \hfill {right}" if right else left


def compile_tex(tex_content: str, name: str, label: str) -> bytes:
    with tempfile.TemporaryDirectory() as temp_dir:
        tex_file = os.path.join(temp_dir, f"{name}.tex")
        pdf_file = os.path.join(temp_dir, f"{name}.pdf")
        log_file = os.path.join(temp_dir, f"{name}.log")
        with open(tex_file, "w", encoding="utf-8") as f:
            f.write(tex_content)

        cmd = ["xelatex", "-interaction=nonstopmode", "-halt-on-error",
               f"-output-directory={temp_dir}", tex_file]
        for _ in range(2):
            subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)

        if not os.path.exists(pdf_file):
            detail = "Erreur de compilation inconnue."
            if os.path.exists(log_file):
                with open(log_file, "r", encoding="utf-8", errors="ignore") as f:
                    lines = f.readlines()
                for i, line in enumerate(lines):
                    if line.startswith("!"):
                        detail = "".join(lines[i:i + 6]).strip()   # error + "l.<n>" context
                        break
            raise HTTPException(status_code=422, detail=f"Échec XeLaTeX ({label}) :\n{detail}")

        with open(pdf_file, "rb") as f:
            return f.read()


def pdf_response(pdf: bytes, filename: str) -> Response:
    return Response(content=pdf, media_type="application/pdf", headers={
        "Content-Disposition": f'attachment; filename="{filename}"; filename*=UTF-8\'\'{quote(filename)}'})


PREAMBLE = r"""\usepackage{fontspec}
\usepackage{polyglossia}
\setdefaultlanguage{%s}
\usepackage{xcolor}
\usepackage[hidelinks]{hyperref}
\usepackage{enumitem}"""


# ================================================================== resume ===
def normalize_resume(body: dict) -> dict:
    """Accept every shape the LLM has produced so far."""
    b = clean_keys(body)
    pi = b.get("personal_information") or b.get("basics") or {}

    summary = first(b, "PROFILE_SUMMARY", "summary") or first(pi, "summary")
    if not raw(summary):
        raise HTTPException(status_code=422, detail="PROFILE_SUMMARY manquant.")

    # skills: {"Cat": [..]}  or  [{"category": "Cat", "skills": [..]}]  or  ["a", "b"]
    skills_in, skills = b.get("skills") or {}, {}
    if isinstance(skills_in, dict):
        skills = {k: as_list(v) for k, v in skills_in.items()}
    elif isinstance(skills_in, list):
        for s in skills_in:
            if isinstance(s, dict):
                skills[first(s, "category", "name", default="Compétences")] = as_list(first(s, "skills", "keywords", "items", default=[]))
            elif s:
                skills.setdefault("", []).append(str(s))

    experience = []
    for e in b.get("experience") or b.get("work") or []:
        if not isinstance(e, dict):
            continue
        dates = first(e, "dates")
        if not dates and (e.get("startDate") or e.get("endDate")):
            dates = f"{e.get('startDate', '')} – {e.get('endDate', '')}".strip(" –")
        experience.append({
            "title": first(e, "title", "position", "role"),
            "company": first(e, "company", "name", "organization"),
            "location": first(e, "location"),
            "dates": dates,
            "bullets": as_list(first(e, "responsibilities", "highlights", "bullets", "description", default=[])),
        })

    education = []
    for ed in b.get("education") or []:
        if not isinstance(ed, dict):
            continue
        dates = first(ed, "dates")
        if not dates and (ed.get("startDate") or ed.get("endDate")):
            dates = f"{ed.get('startDate', '')} – {ed.get('endDate', '')}".strip(" –")
        education.append({
            "degree": first(ed, "degree", "area", "studyType"),
            "institution": first(ed, "institution", "school"),
            "dates": dates,
        })

    lang = first(b, "SECTION_LANG", "LANG")
    english = raw(lang).lower().startswith("en") if lang else is_english(summary)

    return {
        "name": first(pi, "full_name", "name") or ENV["CV_NAME"],
        "headline": first(b, "HEADLINE") or first(pi, "title", "label"),
        "location": first(pi, "location") or ENV["CV_LOCATION"],
        "email": first(pi, "email") or ENV["CV_EMAIL"],
        "phone": first(pi, "phone") or ENV["CV_PHONE"],
        "github": first(pi, "github") or ENV["CV_GITHUB"],
        "linkedin": first(pi, "linkedin") or ENV["CV_LINKEDIN"],
        "summary": summary,
        "skills": skills,
        "experience": experience,
        "education": education,
        "certifications": as_list(b.get("certifications")),
        "languages": as_list(b.get("languages")),
        "english": english,
    }


def render_resume(d: dict) -> str:
    h = ({"profile": "Profile", "skills": "Skills", "exp": "Professional Experience",
          "edu": "Education", "certs": "Certifications", "langs": "Languages"} if d["english"] else
         {"profile": "Profil", "skills": "Compétences", "exp": "Expérience professionnelle",
          "edu": "Formation", "certs": "Certifications", "langs": "Langues"})
    out = [
        r"\documentclass[10pt,a4paper]{article}",
        r"\usepackage[a4paper,left=1.5cm,right=1.5cm,top=1.4cm,bottom=1.4cm]{geometry}",
        PREAMBLE % ("english" if d["english"] else "french"),
        r"\usepackage{titlesec}",
        r"\usepackage{setspace}",
        r"\setstretch{1.12}",
        r"\definecolor{primary}{RGB}{33,37,41}",
        r"\pagestyle{empty}",
        r"\setlength{\parindent}{0pt}",
        r"\titleformat{\section}{\large\bfseries\scshape\color{primary}}{}{0em}{}[\titlerule]",
        r"\titlespacing*{\section}{0pt}{9pt}{4pt}",
        r"\setlist[itemize]{leftmargin=1.2em,labelsep=0.4em,topsep=1pt,itemsep=1pt,parsep=0pt}",
        r"\newcommand{\needlines}[1]{\par\ifdim\dimexpr\pagegoal-\pagetotal\relax<#1\baselineskip\newpage\fi}",
        rf"\hypersetup{{pdfauthor={{{tex(d['name'])}}},pdftitle={{CV - {tex(d['name'])}}}}}",
        r"\begin{document}",
        r"\begin{center}",
        rf"{{\Huge\bfseries\scshape {tex(d['name'])}}}\\[3pt]",
    ]
    if raw(d["headline"]):
        out.append(rf"{{\large {tex(d['headline'])}}}\\[2pt]")
    out += [r"\small " + contact_line(d["location"], d["email"], d["phone"], d["github"], d["linkedin"]),
            r"\end{center}",
            rf"\section*{{{h['profile']}}}", tex(d["summary"])]

    skills = {k: v for k, v in d["skills"].items() if v}
    if skills:
        out += [rf"\section*{{{h['skills']}}}", r"\begin{itemize}[leftmargin=0pt,label={}]"]
        for cat, items in skills.items():
            prefix = rf"\textbf{{{tex(cat)}}} : " if raw(cat) else ""
            out.append(r"  \item " + prefix + ", ".join(tex(i) for i in items))
        out.append(r"\end{itemize}")

    if d["experience"]:
        out.append(rf"\section*{{{h['exp']}}}")
        for e in d["experience"]:
            lines = [two_col(rf"\textbf{{{tex(e['title'])}}}", tex(e["dates"]))]
            if raw(e["company"]) or raw(e["location"]):
                lines.append(two_col(rf"\textit{{{tex(e['company'])}}}",
                                     rf"\textit{{{tex(e['location'])}}}" if raw(e["location"]) else ""))
            # keep the job header with its first bullet, but let the page break between jobs
            out += [r"\needlines{5}", " \\\\*\n".join(lines) + r"\nopagebreak", itemize(e["bullets"]), r"\vspace{3pt}"]

    if d["education"]:
        out.append(rf"\section*{{{h['edu']}}}")
        for ed in d["education"]:
            lines = [two_col(rf"\textbf{{{tex(ed['degree'])}}}", tex(ed["dates"]))]
            if raw(ed["institution"]):
                lines.append(rf"\textit{{{tex(ed['institution'])}}}")
            out += [" \\\\\n".join(lines), r"\vspace{3pt}"]

    if d["certifications"]:
        out += [rf"\section*{{{h['certs']}}}", itemize(d["certifications"])]

    if d["languages"]:
        out += [rf"\section*{{{h['langs']}}}", r" ~$\diamond$~ ".join(tex(l) for l in d["languages"])]

    out.append(r"\end{document}")
    return "\n".join(out)


@app.post("/compile-resume")
async def compile_resume(body: Dict[str, Any] = Body(...)):
    return pdf_response(compile_tex(render_resume(normalize_resume(body)), "resume", "CV"),
                        "CV_generated.pdf")


# ============================================================ cover letter ===
def render_letter(b: dict) -> str:
    b = clean_keys(b)
    paras = [first(b, k) for k in ["PARAGRAPH_HOOK", "PARAGRAPH_VALUE", "PARAGRAPH_ALIGNMENT", "PARAGRAPH_CTA"]]
    if not any(raw(p) for p in paras):
        raise HTTPException(status_code=422, detail="Paragraphes de la lettre manquants.")

    lang = first(b, "LETTER_LANG", "LANG")
    en = raw(lang).lower().startswith("en") if lang else is_english(" ".join(map(str, paras)))
    t = ({"to": "To:", "subject": "Application for the position of", "greet": "Dear Hiring Manager,",
          "close": "Kind regards,"} if en else
         {"to": "À l'attention de :", "subject": "Objet : Candidature au poste de",
          "greet": "Madame, Monsieur,", "close": "Bien cordialement,"})

    recipient = raw(first(b, "RECIPIENT_NAME"))
    company = raw(first(b, "COMPANY_NAME"))
    job = raw(first(b, "JOB_TITLE"))
    generic = recipient.lower() in ("", "madame, monsieur", "hiring manager", "madame, monsieur,")
    greeting = t["greet"] if generic else (f"Dear {recipient}," if en else f"{recipient},")

    right = []
    if recipient and not generic:
        right.append(rf"\textbf{{{t['to']}}} {tex(recipient)}")
    if company:
        right.append(rf"\textbf{{{tex(company)}}}")

    name = ENV["CV_NAME"]
    return "\n\n".join([
        r"\documentclass[11pt,a4paper]{article}",
        r"\usepackage[top=2cm,bottom=2cm,left=2.2cm,right=2.2cm]{geometry}",
        PREAMBLE % ("english" if en else "french"),
        r"\definecolor{primary}{RGB}{30,41,59}",
        r"\definecolor{secondary}{RGB}{71,85,105}",
        r"\pagestyle{empty}",
        r"\setlength{\parindent}{0pt}",
        r"\setlength{\parskip}{0.8em}",
        r"\begin{document}",
        rf"{{\Huge\bfseries\color{{primary}} {tex(name)}}}\\[0.3em]",
        r"{\small\color{secondary} " + contact_line(ENV["CV_LOCATION"], ENV["CV_EMAIL"], ENV["CV_PHONE"],
                                                     ENV["CV_GITHUB"], ENV["CV_LINKEDIN"]) + "}",
        r"\vspace{0.4cm}\hrule\vspace{0.4cm}",
        r"\today\par",
        (r"\begin{flushright}" + " \\\\\n".join(right) + r"\end{flushright}") if right else "",
        rf"\textbf{{\color{{primary}}{t['subject']} {tex(job)}}}" if job else "",
        r"\vspace{0.3cm}",
        tex(greeting),
        "\n\n".join(tex(p) for p in paras if raw(p)),
        r"\vspace{0.6cm}",
        t["close"],
        r"\vspace{0.3cm}",
        rf"\textbf{{{tex(name)}}}",
        r"\end{document}",
    ])


@app.post("/compile-cover-letter")
async def compile_cover_letter(body: Dict[str, Any] = Body(...)):
    return pdf_response(compile_tex(render_letter(body), "cover_letter", "Lettre"),
                        "cover_letter_generated.pdf")