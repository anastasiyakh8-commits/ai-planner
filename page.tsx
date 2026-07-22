"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Priority = "high" | "medium" | "low";
type ListKind = "today" | "inbox";

type Task = {
  id: string;
  title: string;
  priority: Priority;
  list: ListKind;
  time: string | null;
  deadline: string | null; // YYYY-MM-DD
  done: boolean;
  createdAt: number;
};

const STORAGE_KEY = "ai-planner-tasks-v1";
const ONBOARD_KEY = "ai-planner-onboarded-v1";

const EXAMPLE_DUMP =
  "подзвонити стоматологу і записатися на прийом, сьогодні о 15:00 дзвінок з Олею по проєкту, купити подарунок мамі до неділі, оплатити комуналку до 25-го, і колись нарешті розібрати шафу";

const THINKING_LINES = [
  "Секунду, розбираю…",
  "Дивлюсь, що тут головне…",
  "Ще трохи…",
];

const CALM_DONE_LINES = [
  "Один крок зроблено. Гарний темп.",
  "Ще трохи — і день закритий.",
  "Усе виконано. Сьогодні ти впорався чудово.",
];

const PRIORITY_META: Record<Priority, { label: string; badge: string }> = {
  high: { label: "важливо", badge: "bg-[#F3DCCB] text-[#A05B2C]" },
  medium: { label: "звичайно", badge: "bg-[#EBE8E1] text-[#7B7770]" },
  low: { label: "гнучко", badge: "bg-[#EBE8E1] text-[#7B7770]" },
};

const PRIORITY_ORDER: Record<Priority, number> = { high: 0, medium: 1, low: 2 };

function uid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function formatDeadline(iso: string): string {
  const parts = iso.split("-").map(Number);
  const m = parts[1];
  const d = parts[2];
  if (!m || !d) return iso;
  return `${String(d).padStart(2, "0")}.${String(m).padStart(2, "0")}`;
}

function todayIso(): string {
  return new Intl.DateTimeFormat("en-CA").format(new Date());
}

function greeting(): string {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return "Доброго ранку";
  if (h >= 12 && h < 18) return "Доброго дня";
  if (h >= 18 && h < 23) return "Доброго вечора";
  return "Пізня година";
}

function todayHuman(): string {
  return new Intl.DateTimeFormat("uk-UA", {
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date());
}

function sortTasks(list: Task[]): Task[] {
  return [...list].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    if (PRIORITY_ORDER[a.priority] !== PRIORITY_ORDER[b.priority]) {
      return PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
    }
    if (a.time && b.time) return a.time.localeCompare(b.time);
    if (a.time) return -1;
    if (b.time) return 1;
    return a.createdAt - b.createdAt;
  });
}

function isOverdue(t: Task): boolean {
  if (!t.deadline || t.done) return false;
  return t.deadline < todayIso();
}

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function dayGroupLabel(createdAt: number): string {
  const diffDays = Math.round((startOfDay(Date.now()) - startOfDay(createdAt)) / 86400000);
  if (diffDays <= 0) return "Сьогодні";
  if (diffDays === 1) return "Вчора";
  if (diffDays <= 7) return "Раніше цього тижня";
  return "Давніше";
}

function groupByDay(list: Task[]): { label: string; items: Task[] }[] {
  const order = ["Сьогодні", "Вчора", "Раніше цього тижня", "Давніше"];
  const map = new Map<string, Task[]>();
  for (const t of list) {
    const label = dayGroupLabel(t.createdAt);
    if (!map.has(label)) map.set(label, []);
    map.get(label)!.push(t);
  }
  return order.filter((l) => map.has(l)).map((label) => ({ label, items: sortTasks(map.get(label)!) }));
}

function pluralTasks(n: number): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return "справу";
  if (m10 >= 2 && m10 <= 4 && !(m100 >= 12 && m100 <= 14)) return "справи";
  return "справ";
}

type NoraMood = "idle" | "listening" | "thinking" | "happy" | "calm";

function Nora({ mood, size }: { mood: NoraMood; size: number }) {
  return (
    <div
      className={`relative mx-auto aura-${mood}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {mood === "listening" && <div className="aura-ring" />}
      <div className="aura-core" />
    </div>
  );
}

export default function Home() {
  const [mounted, setMounted] = useState(false);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [thinkingLine, setThinkingLine] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [onboarded, setOnboarded] = useState(true);
  const [listening, setListening] = useState(false);
  const [speechSupported, setSpeechSupported] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editPriority, setEditPriority] = useState<Priority>("medium");
  const [editTime, setEditTime] = useState("");
  const [praise] = useState(
    () => CALM_DONE_LINES[CALM_DONE_LINES.length - 1]
  );

  const recognitionRef = useRef<any>(null);
  const baseTextRef = useRef("");

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) setTasks(JSON.parse(saved));
      setOnboarded(localStorage.getItem(ONBOARD_KEY) === "1");
    } catch {
      // ignore
    }
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    setSpeechSupported(Boolean(SR));
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
    } catch {
      // ignore
    }
  }, [tasks, mounted]);

  useEffect(() => {
    if (!loading) return;
    setThinkingLine(0);
    const t = setInterval(() => setThinkingLine((p) => (p + 1) % THINKING_LINES.length), 1300);
    return () => clearInterval(t);
  }, [loading]);

  const finishOnboarding = useCallback(() => {
    setOnboarded(true);
    try {
      localStorage.setItem(ONBOARD_KEY, "1");
    } catch {
      // ignore
    }
  }, []);

  const stopListening = useCallback(() => {
    try {
      recognitionRef.current?.stop();
    } catch {
      // ignore
    }
    setListening(false);
  }, []);

  const toggleListening = useCallback(() => {
    if (listening) {
      stopListening();
      return;
    }
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return;
    const rec = new SR();
    rec.lang = "uk-UA";
    rec.continuous = true;
    rec.interimResults = true;
    baseTextRef.current = input ? input.trimEnd() + " " : "";
    rec.onresult = (e: any) => {
      let finalText = "";
      let interim = "";
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      setInput(baseTextRef.current + finalText + interim);
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recognitionRef.current = rec;
    try {
      rec.start();
      setListening(true);
      setError(null);
      setSummary(null);
    } catch {
      setListening(false);
    }
  }, [input, listening, stopListening]);

  const parse = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;
    stopListening();
    setLoading(true);
    setError(null);
    setSummary(null);
    try {
      const res = await fetch("/api/parse", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error || "Щось пішло не так. Спробуй ще раз.");
        return;
      }
      const incoming: Task[] = (data.tasks || []).map(
        (
          t: { title: string; priority: Priority; list: ListKind; time: string | null; deadline: string | null },
          i: number
        ) => ({ ...t, id: uid(), done: false, createdAt: Date.now() + i })
      );

      let overdueAfter = false;
      setTasks((prev) => {
        const next = [...prev, ...incoming];
        overdueAfter = next.some(isOverdue);
        return next;
      });

      const todayCount = incoming.filter((t) => t.list === "today").length;
      let s = `Додала ${incoming.length} ${pluralTasks(incoming.length)}.`;
      if (todayCount > 0) s += ` ${todayCount} із них поставила в план на день.`;
      s += overdueAfter ? " Є прострочене — підсвітила його нижче." : " Решту тримаю напоготові.";
      setSummary(s);

      setInput("");
      finishOnboarding();
    } catch {
      setError("Немає звʼязку. Перевір інтернет і спробуй ще раз.");
    } finally {
      setLoading(false);
    }
  }, [input, loading, stopListening, finishOnboarding]);

  const toggleDone = useCallback((id: string) => {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, done: !t.done } : t)));
  }, []);

  const removeTask = useCallback((id: string) => {
    setTasks((prev) => prev.filter((t) => t.id !== id));
    setEditingTask(null);
  }, []);

  const moveTask = useCallback((id: string, list: ListKind) => {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, list } : t)));
  }, []);

  const clearDone = useCallback(() => {
    setTasks((prev) => prev.filter((t) => !(t.list === "today" && t.done)));
  }, []);

  const openEdit = useCallback((t: Task) => {
    setEditingTask(t);
    setEditTitle(t.title);
    setEditPriority(t.priority);
    setEditTime(t.time || "");
  }, []);

  const saveEdit = useCallback(() => {
    if (!editingTask) return;
    const title = editTitle.trim();
    if (!title) return;
    const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(editTime.trim()) ? editTime.trim() : null;
    setTasks((prev) =>
      prev.map((t) => (t.id === editingTask.id ? { ...t, title, priority: editPriority, time } : t))
    );
    setEditingTask(null);
  }, [editingTask, editTitle, editPriority, editTime]);

  const today = sortTasks(tasks.filter((t) => t.list === "today"));
  const rest = tasks.filter((t) => t.list === "inbox");
  const groupedRest = groupByDay(rest);
  const overdueCount = tasks.filter(isOverdue).length;
  const doneCount = today.filter((t) => t.done).length;
  const allDone = today.length > 0 && doneCount === today.length;
  const progress = today.length > 0 ? (doneCount / today.length) * 100 : 0;
  const showOnboarding = mounted && !onboarded && tasks.length === 0;

  const noraMood: NoraMood = loading ? "thinking" : listening ? "listening" : summary ? "happy" : "idle";

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-5 px-4 pb-24 pt-7 text-[#191815]">
      {/* Повноекранне знайомство — лише один раз */}
      {showOnboarding && (
        <div className="fixed inset-0 z-30 flex flex-col justify-between bg-[#F6F5F2] px-7 py-14">
          <div className="text-center text-[11px] font-semibold tracking-[6px] text-[#7B7770]">НОРА</div>
          <div className="flex flex-1 flex-col items-center justify-center text-center">
            <Nora mood="idle" size={110} />
            <p className="font-serif-display mt-9 text-[21px] leading-[1.7] text-[#191815]">
              Я Нора.
              <br />
              Ти можеш не думати про списки.
              <br />
              Просто розкажи, що сьогодні на думці.
              <br />
              <span className="text-[#B5793A]">Далі — моя робота.</span>
            </p>
          </div>
          <button
            onClick={finishOnboarding}
            className="w-full rounded-2xl bg-[#191815] px-4 py-4 text-[15.5px] font-semibold text-white active:scale-[0.98]"
          >
            Розповісти
          </button>
        </div>
      )}

      {/* Хедер */}
      <header className="flex items-center justify-between">
        <div>
          <div className="text-[10px] font-semibold tracking-[4px] text-[#7B7770]">НОРА</div>
          {mounted && (
            <p className="font-serif-display mt-1 text-[19px] text-[#191815]">
              {greeting()}
            </p>
          )}
        </div>
        <div className="text-right">
          {mounted && <p className="text-xs text-[#7B7770]">{todayHuman()}</p>}
          {mounted && today.length > 0 && (
            <p className="mt-0.5 text-xs font-medium text-[#7B7770]">
              {doneCount}/{today.length} виконано
            </p>
          )}
        </div>
      </header>
      {mounted && today.length > 0 && (
        <div className="-mt-3 h-1.5 w-full overflow-hidden rounded-full bg-[#E8E5DF]">
          <div
            className="h-full rounded-full bg-[#C88A4E] transition-all duration-700"
            style={{ width: `${progress}%` }}
          />
        </div>
      )}

      {/* Capture */}
      <section className="rounded-[22px] border border-[#E8E5DF] bg-white p-4 shadow-[0_10px_26px_rgba(35,28,20,.06)]">
        <div className="flex flex-col items-center pb-1">
          <Nora mood={noraMood} size={64} />
          <p className="font-serif-display mt-3 text-center text-[17px] text-[#191815]">
            {loading
              ? THINKING_LINES[thinkingLine]
              : listening
              ? "Слухаю тебе…"
              : "Що сьогодні займає твої думки?"}
          </p>
        </div>

        {speechSupported && (
          <div className="mt-3 flex flex-col items-center">
            <button
              onClick={toggleListening}
              aria-label={listening ? "Зупинити запис" : "Говорити"}
              className={`flex h-[68px] w-[68px] items-center justify-center rounded-full transition active:scale-95 ${
                listening ? "bg-[#A8402F]" : "bg-[#191815]"
              }`}
            >
              {listening ? (
                <span className="block h-4 w-4 rounded-[3px] bg-white" />
              ) : (
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round">
                  <rect x="9" y="2.5" width="6" height="12.5" rx="3" />
                  <path d="M5.5 11a6.5 6.5 0 0 0 13 0" />
                  <line x1="12" y1="17.5" x2="12" y2="21.5" />
                </svg>
              )}
            </button>
            <span className="mt-2 text-[13px] font-semibold text-[#191815]">
              {listening ? "Зупинити" : "Говорити"}
            </span>
          </div>
        )}

        <div className="mt-4">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Або просто напиши, що на думці…"
            rows={3}
            className="w-full resize-none rounded-2xl border border-[#E8E5DF] bg-[#FBFAF8] p-3.5 text-[15px] leading-relaxed text-[#191815] placeholder-[#A9A49B] outline-none focus:border-[#C88A4E]"
          />
          {listening && (
            <p className="mt-1.5 text-center text-xs text-[#7B7770]">
              Можеш поправити текст, якщо щось почулося не так
            </p>
          )}
        </div>

        <button
          onClick={parse}
          disabled={loading || !input.trim()}
          className="mt-3 w-full rounded-2xl bg-[#191815] px-4 py-3.5 text-[15px] font-semibold text-white transition active:scale-[0.98] disabled:opacity-35"
        >
          {loading ? "Хвилинку…" : "Готово"}
        </button>

        {!input && !loading && tasks.length === 0 && (
          <button
            onClick={() => setInput(EXAMPLE_DUMP)}
            className="mt-2 w-full text-center text-xs text-[#7B7770] underline underline-offset-2"
          >
            спробувати на прикладі
          </button>
        )}

        {error && (
          <p className="mt-2 rounded-xl bg-[#F7E7E2] p-2.5 text-center text-xs text-[#A8402F]">{error}</p>
        )}
      </section>

      {/* Нора підсумувала */}
      {summary && !loading && (
        <section className="task-appear flex items-center gap-3 rounded-2xl border border-[#F0E3CC] bg-[#FBF6EC] px-4 py-3.5">
          <Nora mood="happy" size={30} />
          <p className="text-[13.5px] leading-relaxed text-[#191815]">{summary}</p>
        </section>
      )}

      {/* Похвала за закритий день */}
      {mounted && allDone && !summary && (
        <section className="task-appear flex items-center gap-3 rounded-2xl border border-[#DCEAE2] bg-[#EEF5F1] px-4 py-3.5">
          <Nora mood="happy" size={30} />
          <p className="text-[13.5px] text-[#3E5E4F]">{praise}</p>
        </section>
      )}

      {/* Сьогодні */}
      {mounted && (
        <section>
          <h2 className="font-serif-display mb-2 flex items-center gap-2 text-[17px] text-[#191815]">
            Сьогодні
            {doneCount > 0 && (
              <button
                onClick={clearDone}
                className="ml-auto font-sans text-[12px] font-normal text-[#7B7770] underline underline-offset-2"
              >
                прибрати виконані
              </button>
            )}
          </h2>
          {today.length === 0 ? (
            <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-[#DFDBD2] py-8">
              <Nora mood="calm" size={40} />
              <p className="text-center text-[13.5px] text-[#7B7770]">
                Тут поки тихо. Коли будеш готовий — я поруч.
              </p>
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {today.map((t) => (
                <TaskRow key={t.id} task={t} onToggle={toggleDone} onEdit={openEdit} late={isOverdue(t)} />
              ))}
            </ul>
          )}
        </section>
      )}

      {/* Усі справи — згруповані за днем внесення */}
      {mounted && rest.length > 0 && (
        <section>
          <h2 className="font-serif-display mb-2 flex items-baseline gap-2 text-[17px] text-[#191815]">
            Усі справи
            <span className="font-sans text-[12px] font-normal text-[#7B7770]">
              {rest.length} {pluralTasks(rest.length)}
              {overdueCount > 0 ? ` · ${overdueCount} горить` : ""}
            </span>
          </h2>
          <div className="flex flex-col gap-1">
            {groupedRest.map((group) => (
              <div key={group.label}>
                <div className="mb-1.5 mt-3 flex items-center gap-2.5 first:mt-0">
                  <span className="text-[11px] font-bold uppercase tracking-[1.5px] text-[#7B7770]">
                    {group.label}
                  </span>
                  <span className="h-px flex-1 bg-[#E8E5DF]" />
                </div>
                <ul className="flex flex-col gap-2">
                  {group.items.map((t) => (
                    <TaskRow
                      key={t.id}
                      task={t}
                      onToggle={toggleDone}
                      onEdit={openEdit}
                      late={isOverdue(t)}
                      onPromote={() => moveTask(t.id, "today")}
                    />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      )}

      <footer className="mt-auto pt-4 text-center text-[11px] text-[#A9A49B]">
        Твої справи лишаються тільки на цьому пристрої
      </footer>

      {/* Sheet редагування */}
      {editingTask && (
        <div
          className="fixed inset-0 z-40 flex items-end bg-black/30"
          onClick={(e) => {
            if (e.target === e.currentTarget) setEditingTask(null);
          }}
        >
          <div className="sheet-up w-full rounded-t-[26px] bg-[#F6F5F2] px-6 pb-8 pt-3.5">
            <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-[#D5D1C9]" />
            <h3 className="font-serif-display text-[18px] text-[#191815]">Редагувати</h3>

            <div className="mt-3 text-[11px] font-bold uppercase tracking-[1.2px] text-[#7B7770]">Назва</div>
            <input
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              className="mt-1.5 w-full rounded-xl border border-[#E8E5DF] bg-white px-3.5 py-3 text-[14.5px] text-[#191815] outline-none focus:border-[#C88A4E]"
            />

            <div className="mt-3 text-[11px] font-bold uppercase tracking-[1.2px] text-[#7B7770]">
              Час (необовʼязково)
            </div>
            <input
              value={editTime}
              onChange={(e) => setEditTime(e.target.value)}
              placeholder="напр. 14:00"
              className="mt-1.5 w-full rounded-xl border border-[#E8E5DF] bg-white px-3.5 py-3 text-[14.5px] text-[#191815] outline-none focus:border-[#C88A4E]"
            />

            <div className="mt-3 text-[11px] font-bold uppercase tracking-[1.2px] text-[#7B7770]">Пріоритет</div>
            <div className="mt-1.5 flex gap-1 rounded-xl bg-[#EBE8E1] p-1">
              {(["high", "medium", "low"] as Priority[]).map((p) => (
                <button
                  key={p}
                  onClick={() => setEditPriority(p)}
                  className={`flex-1 rounded-lg py-2 text-[12.5px] font-semibold capitalize transition ${
                    editPriority === p ? "bg-white text-[#191815] shadow-sm" : "text-[#7B7770]"
                  }`}
                >
                  {PRIORITY_META[p].label}
                </button>
              ))}
            </div>

            <button
              onClick={saveEdit}
              className="mt-5 w-full rounded-2xl bg-[#191815] px-4 py-3.5 text-[15px] font-semibold text-white active:scale-[0.98]"
            >
              Зберегти
            </button>
            <button
              onClick={() => {
                moveTask(editingTask.id, editingTask.list === "today" ? "inbox" : "today");
                setEditingTask(null);
              }}
              className="mt-2 w-full py-2.5 text-center text-[13.5px] font-semibold text-[#191815] opacity-70"
            >
              {editingTask.list === "today" ? "Відкласти на потім" : "Поставити в план на сьогодні"}
            </button>
            <button
              onClick={() => removeTask(editingTask.id)}
              className="mt-1 w-full py-2.5 text-center text-[13.5px] font-semibold text-[#A8402F]"
            >
              Видалити
            </button>
          </div>
        </div>
      )}
    </main>
  );
}

function TaskRow({
  task,
  onToggle,
  onEdit,
  late,
  onPromote,
}: {
  task: Task;
  onToggle: (id: string) => void;
  onEdit: (t: Task) => void;
  late: boolean;
  onPromote?: () => void;
}) {
  const meta = PRIORITY_META[task.priority];
  return (
    <li
      className={`task-appear relative flex items-center gap-3 rounded-2xl border p-3 transition ${
        late ? "border-[#EFC9BE] bg-[#F7E7E2]" : "border-[#E8E5DF] bg-white"
      } ${task.done ? "opacity-50" : ""}`}
    >
      {late && <span className="absolute bottom-3 left-0 top-3 w-[3px] rounded-full bg-[#A8402F]" />}
      <button
        onClick={() => onToggle(task.id)}
        aria-label="Виконано"
        className={`flex h-6 w-6 flex-none items-center justify-center rounded-full border-[1.8px] transition active:scale-90 ${
          task.done ? "border-[#6E9C86] bg-[#6E9C86]" : "border-[#C9C4BB]"
        }`}
      >
        {task.done && (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3.4" strokeLinecap="round">
            <path d="M4 12l5 5L20 6" />
          </svg>
        )}
      </button>

      <div className="min-w-0 flex-1">
        <p className={`truncate text-[14px] font-semibold text-[#191815] ${task.done ? "line-through" : ""}`}>
          {task.title}
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11.5px] text-[#7B7770]">
          {late && <span className="font-bold text-[#A8402F]">вже горить</span>}
          {task.time && <span>{task.time}</span>}
          {task.deadline && <span>до {formatDeadline(task.deadline)}</span>}
        </p>
      </div>

      {!late && (
        <span className={`flex-none rounded-full px-2 py-0.5 text-[10.5px] font-bold ${meta.badge}`}>
          {meta.label}
        </span>
      )}
      {late && (
        <span className="flex-none rounded-full bg-[#A8402F] px-2 py-0.5 text-[10.5px] font-bold text-white">
          прострочено
        </span>
      )}

      {onPromote && !task.done && (
        <button
          onClick={onPromote}
          className="flex-none rounded-lg bg-[#F3EEE3] px-2 py-1.5 text-[11px] font-semibold text-[#B5793A]"
        >
          У сьогодні
        </button>
      )}

      <button
        onClick={() => onEdit(task)}
        aria-label="Редагувати"
        className="flex h-7 w-7 flex-none items-center justify-center rounded-full text-[#B4AEA4] transition active:bg-[#EFECE6]"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
        </svg>
      </button>
    </li>
  );
}
