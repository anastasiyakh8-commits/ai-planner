import { NextResponse } from "next/server";

export const maxDuration = 30;

type ParsedTask = {
  title: string;
  priority: "high" | "medium" | "low";
  list: "today" | "inbox";
  time: string | null;
  deadline: string | null;
};

function kyivToday(): { iso: string; human: string } {
  const now = new Date();
  const iso = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Kiev",
  }).format(now); // YYYY-MM-DD
  const human = new Intl.DateTimeFormat("uk-UA", {
    timeZone: "Europe/Kiev",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(now);
  return { iso, human };
}

function extractJsonArray(text: string): unknown {
  // Модель може повернути зайвий текст або код-фенси — чистимо.
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("no-json-array");
  }
  return JSON.parse(cleaned.slice(start, end + 1));
}

function sanitize(raw: unknown): ParsedTask[] {
  if (!Array.isArray(raw)) return [];
  const out: ParsedTask[] = [];
  for (const item of raw.slice(0, 30)) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    const title = typeof o.title === "string" ? o.title.trim().slice(0, 200) : "";
    if (!title) continue;
    const priority =
      o.priority === "high" || o.priority === "low" ? o.priority : "medium";
    const list = o.list === "today" ? "today" : "inbox";
    const time =
      typeof o.time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(o.time)
        ? o.time
        : null;
    const deadline =
      typeof o.deadline === "string" && /^\d{4}-\d{2}-\d{2}$/.test(o.deadline)
        ? o.deadline
        : null;
    out.push({ title, priority, list, time, deadline });
  }
  return out;
}

export async function POST(req: Request) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Сервер не налаштовано: відсутній API-ключ." },
      { status: 500 }
    );
  }

  let text = "";
  try {
    const body = await req.json();
    text = typeof body.text === "string" ? body.text.trim() : "";
  } catch {
    // ignore
  }
  if (!text) {
    return NextResponse.json(
      { error: "Порожній запит: напиши або надиктуй, що в голові." },
      { status: 400 }
    );
  }
  text = text.slice(0, 4000);

  const { iso, human } = kyivToday();

  const system = `Ти — парсер задач у застосунку-планері. Користувач вивалює потік думок українською (або іншою мовою). Твоя робота — розбити його на окремі короткі задачі.

Сьогодні: ${human} (${iso}), часовий пояс Europe/Kyiv.

Правила:
1. Кожна окрема справа = окрема задача. Розбивай складні речення на атомарні дії.
2. "title" — коротке дієслівне формулювання мовою користувача (наприклад "Подзвонити стоматологу"). Без сміттєвих слів ("треба", "не забути", "ще").
3. "priority": "high" | "medium" | "low" — оцінюй за терміновістю та важливістю зі слів користувача. Невпевнений — "medium".
4. "list": "today" якщо задача явно на сьогодні (сказано "сьогодні", вказано час на сьогодні, або дедлайн сьогодні/прострочений) АБО якщо priority = "high" — важливе завжди потребує уваги сьогодні. Інакше "inbox".
5. "time": "HH:MM" якщо вказано час у будь-якій формі ("о 14:00", "о другій", "до восьмої вечора" → "20:00"), інакше null.
6. "deadline": "YYYY-MM-DD" ТІЛЬКИ якщо є явний маркер ТЕРМІНУ ВИКОНАННЯ: "сьогодні", "завтра", "до пʼятниці", "до 25-го", "через тиждень", "на вихідних". Обчисли реальну дату від сьогодні.
   ⚠ Слова, що описують ЗМІСТ задачі, а не строк — НЕ дедлайн: "реклама НА НАСТУПНИЙ МІСЯЦЬ", "подарунок НА ДЕНЬ НАРОДЖЕННЯ", "звіт ЗА КВАРТАЛ" → deadline: null.
   НІКОЛИ не вигадуй дедлайн чи час, яких не було у введенні. Сумніваєшся — став null: порожньо це чесно, вигадано — це втрата довіри.
7. Ігноруй те, що не є задачею (емоції, вигуки).
8. Відповідай ТІЛЬКИ валідним JSON-масивом без жодного іншого тексту, без markdown, без пояснень.

Формат: [{"title":"...","priority":"...","list":"...","time":null,"deadline":null}]`;

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 2000,
        system,
        messages: [{ role: "user", content: text }],
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error("Anthropic API error:", resp.status, errText.slice(0, 300));
      return NextResponse.json(
        { error: "AI зараз недоступний. Спробуй ще раз за хвилину." },
        { status: 502 }
      );
    }

    const data = await resp.json();
    const content =
      Array.isArray(data.content) && data.content[0]?.type === "text"
        ? (data.content[0].text as string)
        : "";

    const tasks = sanitize(extractJsonArray(content));
    if (tasks.length === 0) {
      return NextResponse.json(
        { error: "Не знайшов задач у тексті. Спробуй описати конкретні справи." },
        { status: 422 }
      );
    }
    return NextResponse.json({ tasks });
  } catch (e) {
    console.error("Parse failure:", e);
    return NextResponse.json(
      { error: "Не вдалося розібрати відповідь AI. Спробуй ще раз." },
      { status: 502 }
    );
  }
}
