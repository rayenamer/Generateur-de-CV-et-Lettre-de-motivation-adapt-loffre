The Pro plan does not include API usage through the Claude Console; for the API, you'd set up Console access and pay separately. But Pro does include Claude Code, the command-line tool, and Claude Code can run non-interactively from a script. So the workaround is a small "bridge" container. It runs Claude Code logged in with your Pro account, and n8n sends its requests there instead of to the API. 
Claude

How it fits together

n8n → claude-bridge container (runs claude -p using your Pro login) → back to n8n in the same format as before. The workflow barely changes: the two Claude nodes now call http://claude-bridge:8080/v1/messages and need no credential. Everything else stays as in the last version, including LaTeX escaping, the fixed schemas and the single profile location.

Setup

Put server.js and Dockerfile in a folder named claude-bridge next to your docker-compose.yml.
On any machine with Claude Code installed (npm install -g @anthropic-ai/claude-code), run claude setup-token. Log in with your Pro account and it prints a long-lived token.
Add that token to your .env as CLAUDE_CODE_OAUTH_TOKEN=.... Then add the service from docker-compose.snippet.yml to your compose file, on the same network as n8n and xelatex-api.
Run docker compose up -d --build claude-bridge. To test it, run docker compose exec n8n wget -qO- http://claude-bridge:8080/health and check that it returns {"ok":true}.
Import cv-cover-letter-claude-pro.json into n8n, paste your profile into Build Prompts, and set up the Telegram token and credentials as before.

If setup-token doesn't work with your Claude Code version, another option is to log in interactively once inside the container (docker compose run claude-bridge claude) and mount /home/node/.claude as a volume so the login persists.

Things to know

Shared limits. Pro usage limits are shared across Claude and Claude Code, so all activity in both counts against the same limits. Each job offer uses two generations (resume and letter). A handful of offers a day is fine, but a burst of them can use up your 5-hour window and also block your normal chat use. If you hit a limit, the bridge returns a 429 error and the n8n run fails with a clear message. Switching MODEL to 'haiku' in Build Prompts uses less of your allowance. 
Claude
No API key in the container. If an ANTHROPIC_API_KEY environment variable is set, Claude Code uses it instead of your subscription and you're billed API rates. The bridge removes that variable just in case, but don't set it in the container. 
Claude
Keep it personal. This works because it's you using your own subscription through Anthropic's official tool. Don't expose the bridge publicly or let other people send jobs through it. If you ever turn this into a tool for others, that's when the API is the right route.
The bridge handles one request at a time, so two offers sent at once will queue instead of running in parallel. That's intentional, to protect your usage limits.

in build prompt 
const CANDIDATE_PROFILE = `
Rayen Ameur
Final-year Technology Engineering student
Email: Rayen_Ameur@hotmail.com | LinkedIn: Rayen Ameur | GitHub: rayenamer | WhatsApp: (+216) 92164742

ABOUT ME
23-year-old final-year engineering student specializing in technology, with experience spanning software engineering, data analytics, AI, and risk modeling. Completed 5 internships in Software Engineering, Predictive Maintenance AI, and Risk Modeling, and held roles including Software Engineer at a Finance & Accounting SaaS, Data Analyst at AIESEC International, and Team Leader at AIESEC Tunisia. Co-founded a company connecting students with international study opportunities, contributing to product development and business strategy. Holds 16 professional certifications from leading technology companies, including Microsoft, IBM, and SAP.

EDUCATION
Information Technology Engineering, ESPRIT (Ecole supérieure privée d'ingénierie et de Technologies), Sep 2022 – Sep 2027

SKILLS
Risk Modeling: Market Risk, Credit Risk, Insurance Risk, Monte Carlo
Generative AI & LLM Engineering: Reinforcement Learning, Harness Engineering, Vector Databases
Software & Infrastructure: Python, Java, COBOL, C#, C, Kubernetes, Terraform, Bash Scripting, CI/CD

EXPERIENCE
Risk Modeling Intern, Poulina Group Holding, Jul 2026 – Aug 2026
- Developed a Market Risk Engine implementing VaR, Expected Shortfall, Historical Simulation, and Monte Carlo Simulation for portfolio risk measurement and stress testing using Python, NumPy, Pandas, SciPy, and statistical modeling.

Risk Modeling Intern, BNA – Banque Nationale Agricole, Jul 2026 – Aug 2026
- Developed a Credit Risk Engine implementing PD, LGD, EAD, and Expected Credit Loss (ECL) models aligned with IFRS 9, using Python, Pandas, NumPy, Scikit-learn, Logistic Regression, and model validation techniques.

Software Engineer, Uvey, Dec 2025 – Apr 2025
- Developed Java-based microservices with Quarkus and contributed to React frontend development for a centralized, automated accounting and financial management software.

Co-Founder, Edugate, Nov 2025 – Present
- Led product development and technology strategy for the country's first platform connecting students with global universities, building the application with Angular and Spring Boot, and managing PostgreSQL, Kubernetes, Docker, and CI/CD pipelines while overseeing business operations.

Data Analyst, AIESEC International, Aug 2025 – Dec 2025
- Analyzed, validated, and visualized global organizational data using Google Sheets, Google Apps Script (JavaScript), and data automation, developing automated reporting workflows and dashboards to support KPI tracking.

AI Engineer Intern, Discovery Intech, Jul 2025 – Aug 2025
- Developed a scalable AI predictive-maintenance system using Machine Learning, Time Series Analysis, and NLP for failure prediction and root-cause analysis, deploying services with FastAPI, Spring Boot, and PostgreSQL.

Software Engineer Intern, Poulina Group Holding, Jul 2024 – Aug 2024
- Implemented CQRS with .NET Core & C#, developed secure RESTful APIs, and built responsive web apps with Angular.

Team Leader, AIESEC in Tunisia, Nov 2022 – Jan 2025
- Led a team managing international internships, optimized CRM pipelines, and shaped committee strategy.

Software Engineer Intern, Poulina Group Holding, Jul 2023 – Aug 2023
- Developed a reporting system using .NET Core, C#, REST APIs, and Angular.
`;

if (CANDIDATE_PROFILE.includes('PASTE_YOUR')) throw new Error('Fill in CANDIDATE_PROFILE in Build Prompts first.');