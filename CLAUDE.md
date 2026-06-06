# Messaoud Assistant — Project Instructions

## Project Overview
A PWA voice/text assistant powered by Claude API, designed to run on Samsung devices via MacroDroid.

## Stack
- Vanilla HTML/CSS/JS (no build step)
- Claude API (Anthropic) via fetch
- PWA manifest for home screen install

## Key Files
- `index.html` — main app UI and logic
- `public/manifest.json` — PWA manifest
- `.env` — API key (never commit)

## Development Rules
- Keep it single-file where possible (index.html)
- No frameworks, no bundlers — pure browser APIs
- API key must come from environment (Netlify env vars in prod)
- Test offline/mobile first

## Deployment
- Netlify (static site, env var: ANTHROPIC_API_KEY)
- Target URL: https://messaoud.netlify.app
