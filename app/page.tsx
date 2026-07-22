"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Task = {
  id: string;
  title: string;
  priority: "high" | "medium" | "low";
  list: "today" | "inbox";
  time: string | null;
  deadline: string | null;
  done: boolean;
  createdAt: number;
};

const STORAGE_KEY = "ai-planner-tasks-v1";
const ONBOARD_KEY = "ai-planner-onboarded-v1";

const EXAMPLE_DUMP =
  "Треба подзвонити стоматологу і записатися на прийом, сьогодні о 15:00 дзвінок з Олею по проєкту, купити подарунок мамі до неділі, оплатити комуналку до 25-го, і колись нарешті розібрати шафу";

const PRIORITY_DOT: Record<Task["priority"], string> = {
  high: "bg-rose-400",
  medium: "bg-amber-300",
  low: "bg-emerald-300",
};

const PRIORITY_ORDER: Record<Task["priority"], number> = {
  high: 0,
  medium: 1,
  low: 2,
};

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

export default function Home() {
  const [mounted, setMounted] = useState(false);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [onboarded, setOnboarded] = useState(true);
  const [listening, setListening] = useState(false);
  const [speechSupported, setSpeechSupported] = useState(false);
  const [justAdded, setJustAdded] = useState(0);

  const recognitionRef = useRef<any>(null);
  const baseTextRef = useRef("");

  // Завантаження стану з localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) setTasks(JSON.parse(saved));
      setOnboarded(localStorage.getItem(ONBOARD_KEY) === "1");
    } catch {
      // ignore
    }
    const SR =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;
    setSpeechSupported(Boolean(SR));
    setMounted(true);
  }, []);

  // Збереження стану
  useEffect(() => {
    if (!mounted) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
    } catch {
      // ignore
    }
  }, [tasks, mounted]);

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
    const SR =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;
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
          t: { title: string; priority: Task["priority"]; list: Task["list"]; time: string | null; deadline: string | null },
          i: number
        ) => ({
          ...t,
          id: uid(),
          done: false,
          createdAt: Date.now() + i,
        })
      );
      setTasks((prev) => [...prev, ...incoming]);
      setInput("");
      setJustAdded(incoming.length);
      setTimeout(() => setJustAdded(0), 2500);
      finishOnboarding();
    } catch {
      setError("Немає звʼязку. Перевір інтернет і спробуй ще раз.");
    } finally {
      setLoading(false);
    }
  }, [input, loading, stopListening, finishOnboarding]);

  const toggleDone = useCallback((id: string) => {
    setTasks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, done: !t.done } : t))
    );
  }, []);

  const removeTask = useCallback((id: string) => {
    setTasks((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const moveToToday = useCallback((id: string) => {
    setTasks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, list: "today" as const } : t))
    );
  }, []);

  const today = sortTasks(tasks.filter((t) => t.list === "today"));
  const inbox = sortTasks(tasks.filter((t) => t.list === "inbox"));
  const doneCount = today.filter((t) => t.done).length;
  const showOnboarding = mounted && !onboarded && tasks.length === 0;

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-5 px-4 pb-16 pt-6">
      {/* Хедер */}
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-white">
            🧠 AI Planner
          </h1>
          <p className="text-xs text-slate-400">
            хаос у голові → план на сьогодні
          </p>
        </div>
        {mounted && today.length > 0 && (
          <div className="rounded-full bg-slate-800/80 px-3 py-1 text-xs font-medium text-slate-300">
            {doneCount}/{today.length} ✓
          </div>
        )}
      </header>

      {/* Онбординг */}
      {showOnboarding && (
        <section className="rounded-2xl border border-indigo-400/20 bg-indigo-500/10 p-4">
          <h2 className="mb-1 text-sm font-semibold text-indigo-200">
            Привіт! Ось як це працює 👋
          </h2>
          <p className="mb-3 text-sm leading-relaxed text-slate-300">
            Вивали все, що крутиться в голові — голосом 🎤 або текстом. AI сам
            розкладе це на задачі з пріоритетами й збере план на сьогодні.
          </p>
          <button
            onClick={() => setInput(EXAMPLE_DUMP)}
            className="w-full rounded-xl bg-indigo-500/20 px-4 py-3 text-sm font-medium text-indigo-200 transition active:scale-[0.98]"
          >
            ✨ Спробувати з прикладом
          </button>
        </section>
      )}

      {/* Capture */}
      <section className="rounded-2xl border border-slate-700/60 bg-slate-900/80 p-3 shadow-lg shadow-black/20">
        <div className="relative">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Що в голові? Справи, дзвінки, ідеї, дедлайни…"
            rows={4}
            className="w-full resize-none rounded-xl bg-slate-800/70 p-3 pr-12 text-[15px] leading-relaxed text-slate-100 placeholder-slate-500 outline-none ring-indigo-400/50 focus:ring-2"
          />
          {speechSupported && (
            <button
              onClick={toggleListening}
              aria-label={listening ? "Зупинити запис" : "Диктувати голосом"}
              className={`absolute bottom-3 right-2 flex h-10 w-10 items-center justify-center rounded-full text-lg transition active:scale-95 ${
                listening
                  ? "animate-pulse bg-rose-500 text-white"
                  : "bg-slate-700 text-slate-200"
              }`}
            >
              {listening ? "■" : "🎤"}
            </button>
          )}
        </div>
        {listening && (
          <p className="mt-2 text-center text-xs text-rose-300">
            🔴 Слухаю… говори, потім натисни ■
          </p>
        )}
        <button
          onClick={parse}
          disabled={loading || !input.trim()}
          className="mt-2 w-full rounded-xl bg-gradient-to-r from-indigo-500 to-violet-500 px-4 py-3.5 text-[15px] font-semibold text-white shadow-lg shadow-indigo-900/40 transition active:scale-[0.98] disabled:opacity-40"
        >
          {loading ? "⏳ Розбираю думки…" : "✨ Розібрати на задачі"}
        </button>
        {error && (
          <p className="mt-2 rounded-lg bg-rose-500/10 p-2 text-center text-xs text-rose-300">
            {error}
          </p>
        )}
        {justAdded > 0 && !error && (
          <p className="mt-2 rounded-lg bg-emerald-500/10 p-2 text-center text-xs text-emerald-300">
            ✓ Додано задач: {justAdded}
          </p>
        )}
      </section>

      {/* Сьогодні */}
      {mounted && (
        <section>
          <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-400">
            📅 Сьогодні
            {today.length > 0 && (
              <span className="rounded-full bg-slate-800 px-2 py-0.5 text-xs">
                {today.length}
              </span>
            )}
          </h2>
          {today.length === 0 ? (
            <p className="rounded-xl border border-dashed border-slate-700 p-4 text-center text-sm text-slate-500">
              План на сьогодні порожній. Вивали думки вище — і він зʼявиться ✨
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {today.map((t) => (
                <TaskRow
                  key={t.id}
                  task={t}
                  onToggle={toggleDone}
                  onRemove={removeTask}
                />
              ))}
            </ul>
          )}
        </section>
      )}

      {/* Інбокс */}
      {mounted && inbox.length > 0 && (
        <section>
          <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-400">
            📥 Інбокс
            <span className="rounded-full bg-slate-800 px-2 py-0.5 text-xs">
              {inbox.length}
            </span>
          </h2>
          <ul className="flex flex-col gap-2">
            {inbox.map((t) => (
              <TaskRow
                key={t.id}
                task={t}
                onToggle={toggleDone}
                onRemove={removeTask}
                onMoveToToday={moveToToday}
              />
            ))}
          </ul>
        </section>
      )}

      <footer className="mt-auto pt-4 text-center text-[11px] text-slate-600">
        Дані зберігаються лише на твоєму пристрої · AI Planner
      </footer>
    </main>
  );
}

function TaskRow({
  task,
  onToggle,
  onRemove,
  onMoveToToday,
}: {
  task: Task;
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
  onMoveToToday?: (id: string) => void;
}) {
  return (
    <li
      className={`flex items-center gap-3 rounded-xl border border-slate-700/50 bg-slate-900/70 p-3 transition ${
        task.done ? "opacity-50" : ""
      }`}
    >
      <button
        onClick={() => onToggle(task.id)}
        aria-label="Виконано"
        className={`flex h-7 w-7 flex-none items-center justify-center rounded-full border-2 text-sm transition active:scale-90 ${
          task.done
            ? "border-emerald-400 bg-emerald-400/20 text-emerald-300"
            : "border-slate-600 text-transparent"
        }`}
      >
        ✓
      </button>
      <div className="min-w-0 flex-1">
        <p
          className={`truncate text-[15px] text-slate-100 ${
            task.done ? "line-through" : ""
          }`}
        >
          {task.title}
        </p>
        {(task.time || task.deadline) && (
          <p className="mt-0.5 flex gap-2 text-xs text-slate-400">
            {task.time && <span>🕐 {task.time}</span>}
            {task.deadline && (
              <span>📆 до {formatDeadline(task.deadline)}</span>
            )}
          </p>
        )}
      </div>
      <span
        className={`h-2.5 w-2.5 flex-none rounded-full ${PRIORITY_DOT[task.priority]}`}
        aria-label={`Пріоритет: ${task.priority}`}
      />
      {onMoveToToday && !task.done && (
        <button
          onClick={() => onMoveToToday(task.id)}
          className="flex-none rounded-lg bg-indigo-500/15 px-2 py-1.5 text-xs font-medium text-indigo-300 transition active:scale-95"
        >
          Сьогодні →
        </button>
      )}
      <button
        onClick={() => onRemove(task.id)}
        aria-label="Видалити"
        className="flex h-8 w-8 flex-none items-center justify-center rounded-lg text-slate-500 transition active:scale-90 active:text-rose-400"
      >
        ✕
      </button>
    </li>
  );
}
