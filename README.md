# AI Planner

Хаос у голові → план на сьогодні. Вивали думки голосом або текстом — AI розкладе їх на задачі.

- Next.js + Tailwind, mobile-first
- AI-парсинг: серверна функція `/api/parse` → Anthropic API (`claude-haiku-4-5`)
- Ключ живе тільки в env `ANTHROPIC_API_KEY` на Vercel
- Дані — в localStorage користувача, без акаунтів
