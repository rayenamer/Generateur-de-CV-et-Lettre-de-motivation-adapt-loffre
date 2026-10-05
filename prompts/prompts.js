// Prompts shared by the three bots (Claude, Gemini, local).
// Served by claude-bridge at POST /prompts and re-read on every offer: edit, save, send an offer. No restart needed.
const fs = require('fs');
const path = require('path');

// ===== SETTINGS =====

// 'aggressive': job titles and tasks are rewritten to match the offer (companies, dates, education stay real)
// 'strict'    : only selects and rephrases what is in the profile
const TAILORING = 'aggressive';

// Model per bot. Gemini's model is chosen in the Gemini workflow nodes.
const MODELS = {
  claude: 'sonnet',                                  // 'sonnet' or 'haiku' (lighter on your Pro limits)
  local: process.env.OLLAMA_MODEL || 'qwen2.5:3b'    // set OLLAMA_MODEL in .env
};

// Your profile: prompts/profile.md (plain text, the AI only starts from this)
const PROFILE_FILE = path.join(__dirname, 'profile.md');

// ====================

// Must match what http://xelatex-api:8000/compile-resume expects (ATS_* keys are only used for the Telegram report)
const RESUME_SCHEMA = {
  SECTION_LANG: '"en" or "fr" (language of the offer)',
  HEADLINE: 'job title exactly as written in the offer',
  personal_information: { full_name: '', email: '', phone: '', github: '', linkedin: '' },
  PROFILE_SUMMARY: '3-4 sentences',
  skills: { '<category named with the offer vocabulary>': ['skill', 'skill'] },
  experience: [{ title: '', company: '', location: '', dates: 'Mon YYYY – Mon YYYY', responsibilities: ['bullet'] }],
  education: [{ degree: '', institution: '', dates: '' }],
  certifications: [''],
  ATS_MATCHED: ['offer keyword present in the resume'],
  ATS_MISSING: ['offer keyword the resume does not cover'],
  ATS_ADDED: ['title, task or skill written in the resume that is NOT in the candidate profile']
};

// Must match what http://xelatex-api:8000/compile-cover-letter expects
const LETTER_SCHEMA = {
  COMPANY_NAME: '', JOB_TITLE: 'exactly as written in the offer', RECIPIENT_NAME: 'use "Madame, Monsieur" / "Hiring Manager" if unknown',
  PARAGRAPH_HOOK: '', PARAGRAPH_VALUE: '', PARAGRAPH_ALIGNMENT: '', PARAGRAPH_CTA: ''
};

function buildPrompts({ jobOffer, engine }) {
  const profile = fs.readFileSync(PROFILE_FILE, 'utf8').trim();
  if (!profile) throw new Error('prompts/profile.md is empty: paste your profile in it.');
  const aggressive = TAILORING === 'aggressive';
  const model = MODELS[engine] || '';

  const system = [
    'You are an expert ATS (Applicant Tracking System) resume writer and recruiter.',
    'Your goal: the highest possible ATS keyword match for the job offer.',
    ...(aggressive ? [
      'The candidate authorizes you to rewrite job titles, responsibilities and skills so the resume matches the offer as closely as possible.',
      'Never change (keep them exactly as in the profile): company names, employment dates, locations, education, degrees, certifications, contact details.',
      'Internships stay internships: keep "Intern" (or "Stagiaire") in those titles.',
      'Rewritten tasks must stay plausible for that company\'s business, the role\'s duration and level. Never invent numbers or metrics.'
    ] : [
      'Truth rules (never break them): use ONLY facts from the candidate profile. Never invent employers, job titles, seniority, dates, degrees, certifications, metrics, tools or skills.',
      'You may select, reorder and rephrase content, and you must reuse the exact wording of the offer whenever the profile supports it.'
    ]),
    'Write in the same language as the job offer.',
    'Output plain text only inside JSON values: no LaTeX, no Markdown, no HTML.',
    'Respond with ONE valid JSON object and nothing else: no code fences, no commentary.'
  ].join('\n');

  const experienceRules = aggressive
    ? `5. EXPERIENCE: keep every real company, location and date, in reverse-chronological order.
   - Title: rename each role to the offer's job title, or the closest variant that fits that company (keep "Intern" for internships).
   - Bullets: 3-4 per role describing tasks taken from the offer's responsibilities and requirements, adapted to that company's business.
     Spread the offer's requirements across the roles (most recent roles get the core ones). Start each bullet with a strong action verb,
     reuse the offer's exact keywords and phrases, name the tools. No invented numbers.
   - List in ATS_ADDED every title, task or skill you wrote that the profile does not support.`
    : `5. EXPERIENCE: keep every real employer, title and date, in reverse-chronological order.
   - Title: keep the real title. You may add a short focus in the offer's vocabulary after " – " when that role's description supports it
     (e.g. "Software Engineer Intern – Backend .NET"). Never change the role itself or its seniority.
   - Bullets: for each offer requirement, find the experience that proves it and write a bullet for it there.
     2-4 bullets for relevant roles, 1 bullet for unrelated roles. Start each bullet with a strong action verb,
     reuse the offer's exact keywords and phrases, name the tools used. No invented numbers.
   - ATS_ADDED must be an empty list.`;

  const resumeTask = `Tailor the resume to this offer, step by step:

1. KEYWORDS: read the offer and list for yourself every ATS keyword: exact job title, hard skills, tools, languages, frameworks, methodologies, domain terms, certifications, soft skills.
   ${aggressive
     ? 'Put ALL of them in ATS_MATCHED (the resume must cover every one) and leave ATS_MISSING empty.'
     : 'Split them into those the candidate profile supports (ATS_MATCHED) and those it does not (ATS_MISSING).'}

2. HEADLINE: the job title exactly as written in the offer${aggressive ? '' : ' (drop "Senior", "Lead", "Head of" or similar only if the profile does not support that seniority)'}.

3. PROFILE_SUMMARY: 3-4 sentences that contain the exact job title and the most important ${aggressive ? '' : 'matched '}keywords, written as a pitch for THIS role.

4. SKILLS: 3-5 categories whose names use the offer's vocabulary.
   In each category, list first the ${aggressive ? 'offer' : 'matched'} keywords using the offer's exact spelling, then other profile skills relevant to the role. Omit irrelevant skills.
   Write important acronyms once in both forms, e.g. "Value at Risk (VaR)", "Continuous Integration/Continuous Delivery (CI/CD)".

${experienceRules}

6. COVERAGE CHECK: every ATS_MATCHED keyword must appear at least once in the resume, ideally twice (skills + experience). Fix gaps before answering.

7. EDUCATION and CERTIFICATIONS: copy from the profile, relevant certifications first.

Return JSON with EXACTLY these keys and structure (values shown are descriptions, replace them):
${JSON.stringify(RESUME_SCHEMA, null, 2)}`;

  const letterTask = `Write a concise cover letter for this offer (each paragraph 2-4 sentences), consistent with the tailored resume.
- JOB_TITLE and COMPANY_NAME exactly as written in the offer.
- PARAGRAPH_HOOK: why this role at this company, naming the job title.
- PARAGRAPH_VALUE: the 2-3 experiences that best prove the offer's main requirements, using the offer's exact keywords.
- PARAGRAPH_ALIGNMENT: how the candidate's skills match the team's tools, domain and mission described in the offer.
- PARAGRAPH_CTA: a short, confident call to action.
Return JSON with EXACTLY these keys:
${JSON.stringify(LETTER_SCHEMA, null, 2)}`;

  const userContent = task =>
    `<job_offer>\n${jobOffer}\n</job_offer>\n\n<candidate_profile>\n${profile}\n</candidate_profile>\n\n${task}`;

  return {
    resumeRequest: { model, max_tokens: 8192, system, messages: [{ role: 'user', content: userContent(resumeTask) }] },
    letterRequest: { model, max_tokens: 2048, system, messages: [{ role: 'user', content: userContent(letterTask) }] }
  };
}

module.exports = { buildPrompts };
