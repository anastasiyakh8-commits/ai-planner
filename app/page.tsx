"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Priority = "high" | "medium" | "low";

type Task = {
  id: string;
  title: string;
  priority: Priority;
  list: "today" | "inbox";
  time: string | null;
  deadline: string | null;
  duration: number;
  done: boolean;
  createdAt: number;
};

type Plan = {
  date: string; // YYYY-MM-DD
  availableMin: number;
  ids: string[];
};

type View = "welcome" | "today" | "all" | "capture" | "confirm" | "thought";
type Mood = "idle" | "listening" | "thinking" | "happy" | "calm";

const STORAGE_KEY = "ai-planner-tasks-v1";
const SEEN_KEY = "nora_seen";
const PLAN_KEY = "nora-plan-v1";
const HOURS_KEY = "nora-hours-default";

const PROCESS_PHRASES = [
  "Розділяю на окремі справи…",
  "Визначаю, що важливо сьогодні…",
  "Формую твій план…",
];

const PLAN_BUFFER = 0.85; // буфер 15% на переключення й непередбачуване

const PRIORITY_LABEL: Record<Priority, string> = {
  high: "Важливо",
  medium: "Вдень",
  low: "Гнучко",
};

const PRIORITY_ORDER: Record<Priority, number> = { high: 0, medium: 1, low: 2 };

function uid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function todayIso(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function formatDuration(min: number): string {
  if (min < 60) return `${min} хв`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m > 0 ? `${h} год ${m} хв` : `${h} год`;
}

function formatHours(min: number): string {
  const h = min / 60;
  return Number.isInteger(h) ? `${h} год` : `${h.toFixed(1)} год`;
}

function formatDeadline(iso: string): string {
  const parts = iso.split("-").map(Number);
  const m = parts[1];
  const d = parts[2];
  if (!m || !d) return iso;
  return `${String(d).padStart(2, "0")}.${String(m).padStart(2, "0")}`;
}

function greeting(): string {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return "Доброго ранку";
  if (h >= 12 && h < 18) return "Доброго дня";
  if (h >= 18 && h < 23) return "Доброго вечора";
  return "Пізня година";
}

function spravPlural(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} справу`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} справи`;
  return `${n} справ`;
}

function isBurning(t: Task): boolean {
  return Boolean(t.deadline && t.deadline <= todayIso() && !t.done);
}

function sortTasks(list: Task[]): Task[] {
  return [...list].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    const ab = isBurning(a) ? 0 : 1;
    const bb = isBurning(b) ? 0 : 1;
    if (ab !== bb) return ab - bb;
    if (PRIORITY_ORDER[a.priority] !== PRIORITY_ORDER[b.priority]) {
      return PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
    }
    if (a.time && b.time) return a.time.localeCompare(b.time);
    if (a.time) return -1;
    if (b.time) return 1;
    return a.createdAt - b.createdAt;
  });
}

/* Планувальник дня — правила спека:
   прострочені → найближчі дедлайни → пріоритет; сума ≤ час × 0.85;
   важке й пріоритетне — спершу, дрібне — під кінець. */
function buildPlan(
  tasks: Task[],
  availableMin: number
): { ids: string[]; leftout: { id: string; reason: string }[] } {
  const budget = Math.floor(availableMin * PLAN_BUFFER);
  const active = tasks.filter((t) => !t.done);

  const rank = (t: Task): number => {
    if (isBurning(t)) return 0;
    if (t.deadline) return 1;
    if (t.priority === "high" || t.list === "today") return 2;
    return 3 + PRIORITY_ORDER[t.priority];
  };

  const candidates = [...active].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (a.deadline && b.deadline && a.deadline !== b.deadline)
      return a.deadline < b.deadline ? -1 : 1;
    if (PRIORITY_ORDER[a.priority] !== PRIORITY_ORDER[b.priority])
      return PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
    return b.duration - a.duration; // важке — вище
  });

  const ids: string[] = [];
  const leftout: { id: string; reason: string }[] = [];
  let sum = 0;
  const farIso = (() => {
    const d = new Date();
    d.setDate(d.getDate() + 3);
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${m}-${day}`;
  })();

  for (const t of candidates) {
    if (sum + t.duration <= budget) {
      ids.push(t.id);
      sum += t.duration;
    } else if (isBurning(t)) {
      // прострочене не ховаємо ніколи — воно важливіше за буфер
      ids.push(t.id);
      sum += t.duration;
    } else {
      let reason = "не вмістилась у твій час";
      if (t.deadline && t.deadline > farIso)
        reason = `дедлайн аж ${formatDeadline(t.deadline)} — може почекати`;
      else if (t.priority === "low") reason = "гнучка — почекає без шкоди";
      leftout.push({ id: t.id, reason });
    }
  }

  // Порядок у дні: прострочене → важке/пріоритетне → дрібне під кінець
  const planned = ids
    .map((id) => active.find((t) => t.id === id))
    .filter(Boolean) as Task[];
  planned.sort((a, b) => {
    const ab = isBurning(a) ? 0 : 1;
    const bb = isBurning(b) ? 0 : 1;
    if (ab !== bb) return ab - bb;
    if (PRIORITY_ORDER[a.priority] !== PRIORITY_ORDER[b.priority])
      return PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
    return b.duration - a.duration;
  });

  return { ids: planned.map((t) => t.id), leftout };
}

function Nora({ mood, size }: { mood: Mood; size: number }) {
  return (
    <div
      className={`nora nora--${mood} flex-none`}
      style={{ width: size, height: size }}
      aria-hidden
    />
  );
}

function MicIcon({ size = 22 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden
    >
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
    </svg>
  );
}

export default function Home() {
  const [mounted, setMounted] = useState(false);
  const [view, setView] = useState<View>("today");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [leftout, setLeftout] = useState<{ id: string; reason: string }[]>([]);
  const [leftoutOpen, setLeftoutOpen] = useState(false);
  const [hours, setHours] = useState(360); // хвилини, дефолт 6 год
  const [draft, setDraft] = useState("");
  const [listening, setListening] = useState(false);
  const [speechSupported, setSpeechSupported] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [phrase, setPhrase] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Task[]>([]);
  const [pendingEditIdx, setPendingEditIdx] = useState<number | null>(null);
  const [pendingEditText, setPendingEditText] = useState("");
  const [lastBatch, setLastBatch] = useState<Task[]>([]);
  const [reaction, setReaction] = useState<string | null>(null);
  const [editing, setEditing] = useState<Task | null>(null);

  const recognitionRef = useRef<any>(null);
  const baseTextRef = useRef("");

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as Array<Partial<Task>>;
        setTasks(parsed.map((t) => ({ duration: 30, ...t }) as Task));
      }
      const savedPlan = localStorage.getItem(PLAN_KEY);
      if (savedPlan) {
        const p = JSON.parse(savedPlan) as Plan;
        // План минулого дня не діє — Today це проєкція, не сховище
        if (p.date === todayIso()) setPlan(p);
      }
      const savedHours = localStorage.getItem(HOURS_KEY);
      if (savedHours) setHours(parseInt(savedHours, 10) || 360);
      if (localStorage.getItem(SEEN_KEY) !== "1") setView("welcome");
    } catch {
      // ignore
    }
    const SR =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;
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
    if (!mounted) return;
    try {
      if (plan) localStorage.setItem(PLAN_KEY, JSON.stringify(plan));
      else localStorage.removeItem(PLAN_KEY);
    } catch {
      // ignore
    }
  }, [plan, mounted]);

  useEffect(() => {
    if (!parsing) return;
    setPhrase(0);
    const t = setInterval(
      () => setPhrase((p) => (p + 1) % PROCESS_PHRASES.length),
      1000
    );
    return () => clearInterval(t);
  }, [parsing]);

  const markSeen = useCallback(() => {
    try {
      localStorage.setItem(SEEN_KEY, "1");
    } catch {
      // ignore
    }
  }, []);

  const changeHours = useCallback((delta: number) => {
    setHours((h) => {
      const next = Math.min(720, Math.max(60, h + delta));
      try {
        localStorage.setItem(HOURS_KEY, String(next));
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  const makePlan = useCallback(() => {
    const { ids, leftout: lo } = buildPlan(tasks, hours);
    setPlan({ date: todayIso(), availableMin: hours, ids });
    setLeftout(lo);
    setLeftoutOpen(false);
  }, [tasks, hours]);

  const resetPlan = useCallback(() => {
    setPlan(null);
    setLeftout([]);
  }, []);

  const removeFromPlan = useCallback((id: string) => {
    setPlan((p) =>
      p ? { ...p, ids: p.ids.filter((x) => x !== id) } : p
    );
  }, []);

  const addToPlan = useCallback((id: string) => {
    setPlan((p) => {
      if (!p) return p;
      if (p.ids.includes(id)) return p;
      return { ...p, ids: [...p.ids, id] };
    });
    setLeftout((lo) => lo.filter((x) => x.id !== id));
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
    baseTextRef.current = draft ? draft.trimEnd() + " " : "";
    rec.onresult = (e: any) => {
      let finalText = "";
      let interim = "";
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      setDraft(baseTextRef.current + finalText + interim);
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
  }, [draft, listening, stopListening]);

  const parse = useCallback(async () => {
    const text = draft.trim();
    if (!text || parsing) return;
    stopListening();
    setParsing(true);
    setError(null);
    try {
      const res = await fetch("/api/parse", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error || "Щось мені завадило подумати. Спробуймо ще раз?");
        return;
      }
      const incoming: Task[] = (data.tasks || []).map(
        (
          t: {
            title: string;
            priority: Priority;
            list: Task["list"];
            time: string | null;
            deadline: string | null;
            duration?: number;
          },
          i: number
        ) => ({
          ...t,
          duration: typeof t.duration === "number" ? t.duration : 30,
          list: t.priority === "high" ? ("today" as const) : t.list,
          id: uid(),
          done: false,
          createdAt: Date.now() + i,
        })
      );
      setPending(incoming);
      setPendingEditIdx(null);
      setView("confirm");
    } catch {
      setError("Звʼязок загубився. Перевір інтернет — і спробуймо ще раз.");
    } finally {
      setParsing(false);
    }
  }, [draft, parsing, stopListening]);

  const savePendingEdit = useCallback(() => {
    setPendingEditIdx((idx) => {
      if (idx !== null) {
        const text = pendingEditText.trim();
        if (text) {
          setPending((prev) =>
            prev.map((t, i) => (i === idx ? { ...t, title: text } : t))
          );
        }
      }
      return null;
    });
  }, [pendingEditText]);

  const togglePendingDay = useCallback((idx: number) => {
    setPending((prev) =>
      prev.map((t, i) =>
        i === idx
          ? { ...t, list: t.list === "today" ? ("inbox" as const) : ("today" as const) }
          : t
      )
    );
  }, []);

  const confirmPending = useCallback(() => {
    setTasks((prev) => [...prev, ...pending]);
    // Якщо план на сьогодні вже є — термінове з нового дампу заходить у нього
    setPlan((p) => {
      if (!p) return p;
      const urgent = pending
        .filter((t) => t.list === "today" || isBurning(t))
        .map((t) => t.id);
      return urgent.length ? { ...p, ids: [...p.ids, ...urgent] } : p;
    });
    setLastBatch(pending);
    setPending([]);
    setDraft("");
    setView("thought");
  }, [pending]);

  const retryCapture = useCallback(() => {
    setPending([]);
    setDraft("");
    setError(null);
    setView("capture");
  }, []);

  const moveToToday = useCallback(
    (id: string) => {
      setTasks((prev) =>
        prev.map((t) => (t.id === id ? { ...t, list: "today" as const } : t))
      );
      addToPlan(id);
      setEditing(null);
    },
    [addToPlan]
  );

  const toggleDone = useCallback(
    (id: string) => {
      setTasks((prev) => {
        const next = prev.map((t) =>
          t.id === id ? { ...t, done: !t.done } : t
        );
        const t = next.find((x) => x.id === id);
        if (t?.done) {
          const planIds = plan?.ids || [];
          const planned = next.filter((x) => planIds.includes(x.id));
          const left = planned.filter((x) => !x.done).length;
          setReaction(
            left === 0 && planned.length > 0
              ? "Усе виконано. Сьогодні ти молодець."
              : "Один крок зроблено. Гарний темп."
          );
          setTimeout(() => setReaction(null), 3000);
        }
        return next;
      });
    },
    [plan]
  );

  const removeTask = useCallback((id: string) => {
    setTasks((prev) => prev.filter((t) => t.id !== id));
    setPlan((p) => (p ? { ...p, ids: p.ids.filter((x) => x !== id) } : p));
    setEditing(null);
  }, []);

  const saveTask = useCallback((updated: Task) => {
    setTasks((prev) => {
      const exists = prev.some((t) => t.id === updated.id);
      return exists
        ? prev.map((t) => (t.id === updated.id ? updated : t))
        : [...prev, updated];
    });
    setEditing(null);
  }, []);

  const startCreate = useCallback(() => {
    setEditing({
      id: uid(),
      title: "",
      priority: "medium",
      list: "inbox",
      time: null,
      deadline: null,
      duration: 30,
      done: false,
      createdAt: Date.now(),
    });
  }, []);

  const postpone = useCallback(
    (id: string) => {
      setTasks((prev) =>
        prev.map((t) => (t.id === id ? { ...t, list: "inbox" as const } : t))
      );
      removeFromPlan(id);
      setEditing(null);
    },
    [removeFromPlan]
  );

  const activeTasks = tasks.filter((t) => !t.done);
  const plannedTasks = (plan?.ids || [])
    .map((id) => tasks.find((t) => t.id === id))
    .filter((t): t is Task => Boolean(t));
  const plannedOpen = plannedTasks.filter((t) => !t.done);
  const doneCount = plannedTasks.filter((t) => t.done).length;
  const allDone = plannedTasks.length > 0 && doneCount === plannedTasks.length;
  const plannedTotalMin = plannedTasks.reduce((s, t) => s + t.duration, 0);
  const doneMin = plannedTasks
    .filter((t) => t.done)
    .reduce((s, t) => s + t.duration, 0);
  const progressPct =
    plannedTotalMin > 0 ? Math.round((doneMin / plannedTotalMin) * 100) : 0;

  const mood: Mood = parsing
    ? "thinking"
    : listening
    ? "listening"
    : view === "thought"
    ? "happy"
    : allDone && view === "today"
    ? "calm"
    : "idle";

  if (!mounted) return <main className="min-h-dvh" />;

  /* ─────────── WELCOME ─────────── */
  if (view === "welcome") {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center gap-8 px-6 pb-16 text-center">
        <Nora mood="idle" size={112} />
        <div>
          <p className="serif rise mb-6 text-xs uppercase tracking-[0.35em] text-[#7B7770]">
            НОРА
          </p>
          <div className="serif space-y-2 text-[22px] leading-snug text-[#191815]">
            <p className="rise-1">Я Нора.</p>
            <p className="rise-1">Ти можеш не думати про списки.</p>
            <p className="rise-2">Просто розкажи, що сьогодні на думці.</p>
            <p className="rise-3 font-semibold">Далі — моя робота.</p>
          </div>
        </div>
        <button
          onClick={() => {
            markSeen();
            setView("capture");
          }}
          className="rise-4 w-full max-w-xs rounded-2xl bg-[#191815] px-6 py-4 text-[15px] font-medium text-[#F6F5F2] transition active:scale-[0.98]"
        >
          Розповісти
        </button>
      </main>
    );
  }

  /* ─────────── CAPTURE ─────────── */
  if (view === "capture") {
    if (parsing) {
      return (
        <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center gap-8 px-6 pb-16 text-center">
          <Nora mood="thinking" size={112} />
          <p className="serif rise text-[18px] italic text-[#7B7770]">
            {PROCESS_PHRASES[phrase]}
          </p>
        </main>
      );
    }
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-6 pb-10 pt-6">
        <button
          onClick={() => {
            stopListening();
            setView("today");
          }}
          className="self-start text-sm text-[#7B7770] transition active:text-[#191815]"
        >
          ← Мій день
        </button>

        <div className="mt-6 flex flex-col items-center gap-6 text-center">
          <Nora mood={mood} size={96} />
          <h1 className="serif text-[24px] leading-snug text-[#191815]">
            Що сьогодні займає твої думки?
          </h1>

          {speechSupported && (
            <button
              onClick={toggleListening}
              className={`flex w-full max-w-xs items-center justify-center gap-2 rounded-2xl px-6 py-4 text-[15px] font-medium transition active:scale-[0.98] ${
                listening
                  ? "bg-[#B5793A] text-white"
                  : "bg-[#191815] text-[#F6F5F2]"
              }`}
            >
              <MicIcon />
              {listening ? "Слухаю… натисни, коли закінчиш" : "Говорити"}
            </button>
          )}

          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Або запиши текстом…"
            rows={4}
            className="w-full resize-none rounded-2xl border border-[#E8E5DF] bg-white/70 p-4 text-left text-[15px] leading-relaxed text-[#191815] placeholder-[#7B7770] outline-none focus:border-[#C88A4E]"
          />

          {error && (
            <p className="w-full rounded-xl bg-[#F7E7E2] p-3 text-sm text-[#A8402F]">
              {error}
            </p>
          )}

          {draft.trim() && !listening && (
            <button
              onClick={parse}
              className="rise w-full max-w-xs rounded-2xl bg-[#191815] px-6 py-4 text-[15px] font-medium text-[#F6F5F2] transition active:scale-[0.98]"
            >
              Далі
            </button>
          )}
        </div>
      </main>
    );
  }

  /* ─────────── «Ось що я зрозуміла» ─────────── */
  if (view === "confirm") {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-6 pb-10 pt-8">
        <div className="flex flex-col items-center gap-2 text-center">
          <Nora mood="idle" size={64} />
          <h1 className="serif mt-3 text-[24px] leading-snug text-[#191815]">
            Ось що я зрозуміла
          </h1>
          <p className="text-sm text-[#7B7770]">Перевір, чи все правильно</p>
        </div>

        <ul className="mt-6 flex flex-col gap-2">
          {pending.map((t, idx) => (
            <li
              key={t.id}
              className="rise rounded-2xl border border-[#E8E5DF] bg-white/70 p-3.5"
              style={{ animationDelay: `${idx * 70}ms` }}
            >
              {pendingEditIdx === idx ? (
                <input
                  value={pendingEditText}
                  onChange={(e) => setPendingEditText(e.target.value)}
                  onBlur={savePendingEdit}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") savePendingEdit();
                    if (e.key === "Escape") setPendingEditIdx(null);
                  }}
                  autoFocus
                  className="w-full rounded-xl border border-[#C88A4E] bg-white p-2 text-[15px] text-[#191815] outline-none"
                />
              ) : (
                <>
                  <button
                    onClick={() => {
                      setPendingEditIdx(idx);
                      setPendingEditText(t.title);
                    }}
                    className="flex w-full items-baseline justify-between gap-3 text-left"
                  >
                    <span className="text-[15px] leading-snug text-[#191815]">
                      {t.title}
                    </span>
                    {t.time && (
                      <span className="flex-none text-sm font-medium text-[#191815]">
                        {t.time}
                      </span>
                    )}
                  </button>
                  <div className="mt-2 flex items-center gap-2">
                    <button
                      onClick={() => togglePendingDay(idx)}
                      className={`rounded-full px-3 py-1 text-xs font-medium transition active:scale-95 ${
                        t.list === "today"
                          ? "bg-[#191815] text-[#F6F5F2]"
                          : "border border-[#E8E5DF] text-[#7B7770]"
                      }`}
                    >
                      {t.list === "today" ? "Мій день ✓" : "На потім"}
                    </button>
                    {t.priority === "high" && (
                      <span className="text-xs font-medium text-[#B5793A]">
                        Важливо
                      </span>
                    )}
                    <span className="text-xs text-[#7B7770]">
                      {formatDuration(t.duration)}
                    </span>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
        <p className="mt-2 text-center text-xs text-[#7B7770]">
          Тапни назву — виправити · мітку — перенести в «Мій день» чи «На потім»
        </p>

        <div className="mt-6 flex flex-col gap-2">
          <button
            onClick={confirmPending}
            className="w-full rounded-2xl bg-[#191815] px-6 py-4 text-[15px] font-medium text-[#F6F5F2] transition active:scale-[0.98]"
          >
            Все правильно
          </button>
          <button
            onClick={retryCapture}
            className="w-full rounded-2xl border border-[#E8E5DF] px-6 py-3.5 text-[15px] text-[#7B7770] transition active:scale-[0.98]"
          >
            Записати ще раз
          </button>
        </div>
      </main>
    );
  }

  /* ─────────── РЕЗУЛЬТАТ ─────────── */
  if (view === "thought") {
    const n = lastBatch.length;
    const attention = lastBatch.filter((t) => t.list === "today").length;
    const kept = n - attention;
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center gap-8 px-6 pb-16 text-center">
        <Nora mood="happy" size={96} />
        <div className="serif space-y-3 text-[20px] leading-snug text-[#191815]">
          <p className="rise-1">Готово.</p>
          <p className="rise-1">Я знайшла {spravPlural(n)}.</p>
          <p className="rise-2">
            {attention === 0
              ? "Сьогодні жодна не термінова — все під контролем."
              : attention === 1
              ? "Одна з них потребує уваги сьогодні."
              : `${attention} з них потребують уваги сьогодні.`}
          </p>
          {kept > 0 && (
            <p className="rise-3 text-[#7B7770]">
              Решту збережу у списку — вони не загубляться.
            </p>
          )}
        </div>
        <button
          onClick={() => setView("today")}
          className="rise-4 w-full max-w-xs rounded-2xl bg-[#191815] px-6 py-4 text-[15px] font-medium text-[#F6F5F2] transition active:scale-[0.98]"
        >
          Показати мій день
        </button>
      </main>
    );
  }

  /* ─────────── ГОЛОВНИЙ ЕКРАН: вкладки ─────────── */
  const isToday = view === "today";

  const overdue = [...tasks]
    .filter((t) => isBurning(t))
    .sort((a, b) => ((a.deadline || "") < (b.deadline || "") ? -1 : 1));
  const withDeadline = [...tasks]
    .filter((t) => !isBurning(t) && t.deadline)
    .sort((a, b) => ((a.deadline || "") < (b.deadline || "") ? -1 : 1));
  const noDeadline = sortTasks(tasks.filter((t) => !t.deadline && !isBurning(t)));
  const groups: { label: string; items: Task[]; alert?: boolean }[] = [
    { label: "Прострочено", items: overdue, alert: true },
    { label: "З дедлайном", items: withDeadline },
    { label: "Без дедлайну", items: noDeadline },
  ];

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-5 px-6 pb-32 pt-8">
      <header className="flex flex-col items-center gap-2 text-center">
        <Nora mood={mood} size={56} />
        <p className="text-sm text-[#7B7770]">{greeting()}.</p>
      </header>

      <nav className="relative grid grid-cols-2 rounded-2xl border border-[#E8E5DF] bg-white/60 p-1">
        <div
          className={`absolute bottom-1 top-1 w-[calc(50%-4px)] rounded-xl bg-[#191815] transition-transform duration-300 ease-out ${
            isToday ? "translate-x-1" : "translate-x-[calc(100%+3px)]"
          }`}
          aria-hidden
        />
        <button
          onClick={() => setView("today")}
          className={`relative z-10 py-3 text-sm font-medium transition-colors duration-300 ${
            isToday ? "text-[#F6F5F2]" : "text-[#7B7770]"
          }`}
        >
          Мій день{plan ? ` · ${plannedTasks.length}` : ""}
        </button>
        <button
          onClick={() => setView("all")}
          className={`relative z-10 py-3 text-sm font-medium transition-colors duration-300 ${
            !isToday ? "text-[#F6F5F2]" : "text-[#7B7770]"
          }`}
        >
          Усі справи{activeTasks.length > 0 ? ` · ${activeTasks.length}` : ""}
        </button>
      </nav>

      <div key={view} className="tab-in flex flex-col gap-4">
        {isToday ? (
          !plan ? (
            /* ── Стан 1: план не сформовано ── */
            <div className="flex flex-col items-center gap-5 pt-4 text-center">
              <h2 className="serif text-[22px] text-[#191815]">
                Скільки часу маєш сьогодні?
              </h2>
              <div className="flex items-center gap-6">
                <button
                  onClick={() => changeHours(-30)}
                  className="flex h-12 w-12 items-center justify-center rounded-full border border-[#E8E5DF] bg-white/70 text-xl text-[#191815] transition active:scale-90"
                  aria-label="Менше часу"
                >
                  −
                </button>
                <span className="serif min-w-24 text-[28px] text-[#191815]">
                  {formatHours(hours)}
                </span>
                <button
                  onClick={() => changeHours(30)}
                  className="flex h-12 w-12 items-center justify-center rounded-full border border-[#E8E5DF] bg-white/70 text-xl text-[#191815] transition active:scale-90"
                  aria-label="Більше часу"
                >
                  +
                </button>
              </div>
              <button
                onClick={makePlan}
                disabled={activeTasks.length === 0}
                className="w-full max-w-xs rounded-2xl bg-[#191815] px-6 py-4 text-[15px] font-medium text-[#F6F5F2] transition active:scale-[0.98] disabled:opacity-40"
              >
                ⚡ Спланувати день
              </button>
              <p className="text-sm text-[#7B7770]">
                {activeTasks.length === 0
                  ? "Спершу розкажи мені, що на думці"
                  : `У списку — ${spravPlural(activeTasks.length).replace("справу", "справа")}`}
              </p>
            </div>
          ) : (
            /* ── Стан 2: план сформовано ── */
            <>
              <div className="rounded-2xl border border-[#E8E5DF] bg-white/60 p-3.5">
                <div className="flex items-baseline justify-between text-sm">
                  <span className="font-medium text-[#191815]">
                    {formatDuration(plannedTotalMin)} із {formatHours(plan.availableMin)}
                  </span>
                  <span className="text-[#7B7770]">
                    виконано {progressPct}%
                  </span>
                </div>
                <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-[#E8E5DF]">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-[#F6DDB8] to-[#C88A4E] transition-all duration-700"
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
              </div>

              {(reaction || allDone) && (
                <p className="rise rounded-2xl bg-[#6E9C86]/10 p-3 text-center text-sm text-[#6E9C86]">
                  {reaction || "Усе виконано. Сьогодні ти молодець."}
                </p>
              )}

              {plannedOpen.length > 0 && !reaction && (
                <p className="text-center text-sm text-[#7B7770]">
                  Почни з:{" "}
                  <span className="font-medium text-[#191815]">
                    {plannedOpen[0].title}
                  </span>
                </p>
              )}

              <ul className="flex flex-col gap-2">
                {plannedTasks.map((t, i) => (
                  <TaskRow
                    key={t.id}
                    task={t}
                    index={i}
                    onToggle={toggleDone}
                    onEdit={() => setEditing(t)}
                    onRemoveFromPlan={!t.done ? removeFromPlan : undefined}
                  />
                ))}
              </ul>

              {leftout.length > 0 && (
                <div className="rounded-2xl border border-[#E8E5DF] bg-white/50">
                  <button
                    onClick={() => setLeftoutOpen((o) => !o)}
                    className="flex w-full items-center justify-between p-3.5 text-sm text-[#7B7770]"
                  >
                    <span>Не влізло сьогодні ({leftout.length})</span>
                    <span>{leftoutOpen ? "▴" : "▾"}</span>
                  </button>
                  {leftoutOpen && (
                    <ul className="flex flex-col gap-2 px-3.5 pb-3.5">
                      {leftout.map((lo) => {
                        const t = tasks.find((x) => x.id === lo.id);
                        if (!t || t.done) return null;
                        return (
                          <li
                            key={lo.id}
                            className="flex items-center gap-3 rounded-xl border border-[#E8E5DF] bg-white/70 p-3"
                          >
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-[14px] text-[#191815]">
                                {t.title}
                              </p>
                              <p className="text-xs text-[#7B7770]">
                                💡 {lo.reason}
                              </p>
                            </div>
                            <button
                              onClick={() => addToPlan(lo.id)}
                              className="flex-none rounded-full border border-[#C88A4E]/50 px-2.5 py-1.5 text-xs font-medium text-[#B5793A] transition active:scale-95"
                            >
                              У день →
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              )}

              <button
                onClick={resetPlan}
                className="self-center text-sm text-[#7B7770] underline underline-offset-4 transition active:text-[#191815]"
              >
                Переспланувати
              </button>
            </>
          )
        ) : (
          <>
            <button
              onClick={startCreate}
              className="rounded-2xl border border-dashed border-[#C88A4E]/50 py-3 text-sm font-medium text-[#B5793A] transition active:scale-[0.98]"
            >
              + Додати справу
            </button>
            {tasks.length === 0 && (
              <div className="rounded-2xl border border-dashed border-[#E8E5DF] p-8 text-center">
                <p className="serif text-[17px] text-[#191815]">Поки тихо.</p>
                <p className="mt-1 text-sm text-[#7B7770]">
                  Розкажи, що на думці.
                </p>
              </div>
            )}
            {groups.map(
              (g) =>
                g.items.length > 0 && (
                  <section key={g.label}>
                    <h2
                      className={`mb-2 text-center text-xs font-medium uppercase tracking-wider ${
                        g.alert ? "text-[#A8402F]" : "text-[#7B7770]"
                      }`}
                    >
                      {g.alert ? "⚠ " : ""}
                      {g.label}
                    </h2>
                    <ul className="flex flex-col gap-2">
                      {g.items.map((t, i) => (
                        <TaskRow
                          key={t.id}
                          task={t}
                          index={i}
                          onToggle={toggleDone}
                          onEdit={() => setEditing(t)}
                          onMoveToday={
                            plan && !plan.ids.includes(t.id) && !t.done
                              ? moveToToday
                              : undefined
                          }
                        />
                      ))}
                    </ul>
                  </section>
                )
            )}
          </>
        )}
      </div>

      <MicFab
        onClick={() => {
          setDraft("");
          setView("capture");
        }}
      />

      {editing && (
        <EditSheet
          task={editing}
          onClose={() => setEditing(null)}
          onSave={saveTask}
          onPostpone={postpone}
          onMoveToday={moveToToday}
          onDelete={removeTask}
        />
      )}
    </main>
  );
}

/* ─────────── Компоненти ─────────── */

function MicFab({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-label="Розповісти Норі"
      className="fixed bottom-6 left-1/2 z-40 flex h-16 w-16 -translate-x-1/2 items-center justify-center rounded-full bg-[#191815] text-[#F6F5F2] shadow-lg shadow-black/25 transition active:scale-95"
    >
      <MicIcon size={26} />
    </button>
  );
}

function TaskRow({
  task,
  index,
  onToggle,
  onEdit,
  onMoveToday,
  onRemoveFromPlan,
}: {
  task: Task;
  index: number;
  onToggle: (id: string) => void;
  onEdit: () => void;
  onMoveToday?: (id: string) => void;
  onRemoveFromPlan?: (id: string) => void;
}) {
  const burning = isBurning(task);
  const important = task.priority === "high" && !burning;

  const surface = burning
    ? "border-l-4 border-[#E8E5DF] border-l-[#A8402F] bg-[#F7E7E2]"
    : important
    ? "border-[#C88A4E]/60 bg-[#F6DDB8]/35"
    : "border-[#E8E5DF] bg-white/70";

  return (
    <li
      className={`rise flex items-center gap-3 rounded-2xl border p-3.5 transition ${surface} ${
        task.done ? "opacity-45" : ""
      }`}
      style={{ animationDelay: `${index * 60}ms` }}
    >
      <button
        onClick={() => onToggle(task.id)}
        aria-label="Виконано"
        className={`flex h-7 w-7 flex-none items-center justify-center rounded-full border-2 text-sm transition active:scale-90 ${
          task.done
            ? "checkpop border-[#6E9C86] bg-[#6E9C86]/15 text-[#6E9C86]"
            : "border-[#D8D4CC] text-transparent"
        }`}
      >
        ✓
      </button>
      <div className="min-w-0 flex-1">
        <p
          className={`truncate text-[15px] text-[#191815] ${
            task.done ? "line-through" : ""
          }`}
        >
          {task.title}
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-[#7B7770]">
          {burning && (
            <span className="rounded-full bg-[#A8402F]/10 px-2 py-0.5 font-medium text-[#A8402F]">
              прострочено
            </span>
          )}
          {important && (
            <span className="font-medium text-[#B5793A]">Важливо</span>
          )}
          {task.time && (
            <span className="font-semibold text-[#191815]">{task.time}</span>
          )}
          <span>{formatDuration(task.duration)}</span>
          {task.deadline && <span>· до {formatDeadline(task.deadline)}</span>}
        </p>
      </div>
      {onMoveToday && (
        <button
          onClick={() => onMoveToday(task.id)}
          className="flex-none rounded-full border border-[#C88A4E]/50 px-2.5 py-1.5 text-xs font-medium text-[#B5793A] transition active:scale-95"
        >
          У день →
        </button>
      )}
      {onRemoveFromPlan && (
        <button
          onClick={() => onRemoveFromPlan(task.id)}
          aria-label="Прибрати з плану"
          className="flex h-9 w-9 flex-none items-center justify-center rounded-xl text-[#7B7770] transition active:scale-90 active:text-[#A8402F]"
        >
          −
        </button>
      )}
      <button
        onClick={onEdit}
        aria-label="Редагувати"
        className="flex h-9 w-9 flex-none items-center justify-center rounded-xl text-[#7B7770] transition active:scale-90 active:text-[#191815]"
      >
        ✎
      </button>
    </li>
  );
}

function EditSheet({
  task,
  onClose,
  onSave,
  onPostpone,
  onMoveToday,
  onDelete,
}: {
  task: Task;
  onClose: () => void;
  onSave: (t: Task) => void;
  onPostpone: (id: string) => void;
  onMoveToday: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [title, setTitle] = useState(task.title);
  const [time, setTime] = useState(task.time || "");
  const [deadline, setDeadline] = useState(task.deadline || "");
  const [priority, setPriority] = useState<Priority>(task.priority);
  const [duration, setDuration] = useState(task.duration || 30);
  const isNew = task.title === "";

  return (
    <div className="fixed inset-0 z-50 flex items-end bg-black/30" onClick={onClose}>
      <div
        className="sheet w-full rounded-t-3xl bg-[#F6F5F2] p-5 pb-8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-[#E8E5DF]" />
        {isNew && (
          <p className="serif mb-3 text-center text-[18px] text-[#191815]">
            Нова справа
          </p>
        )}
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Що потрібно зробити?"
          autoFocus={isNew}
          className="w-full rounded-2xl border border-[#E8E5DF] bg-white/70 p-3.5 text-[15px] text-[#191815] placeholder-[#7B7770] outline-none focus:border-[#C88A4E]"
        />
        <div className="mt-3 flex gap-3">
          <label className="flex-1 text-xs text-[#7B7770]">
            Час
            <input
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className="mt-1 w-full rounded-2xl border border-[#E8E5DF] bg-white/70 p-3 text-[15px] text-[#191815] outline-none focus:border-[#C88A4E]"
            />
          </label>
          <label className="flex-1 text-xs text-[#7B7770]">
            Дедлайн
            <input
              type="date"
              value={deadline}
              onChange={(e) => setDeadline(e.target.value)}
              className="mt-1 w-full rounded-2xl border border-[#E8E5DF] bg-white/70 p-3 text-[15px] text-[#191815] outline-none focus:border-[#C88A4E]"
            />
          </label>
        </div>
        <div className="mt-3">
          <p className="mb-1 text-xs text-[#7B7770]">Тривалість</p>
          <div className="flex overflow-hidden rounded-2xl border border-[#E8E5DF]">
            {[15, 30, 60, 120, 180].map((m) => (
              <button
                key={m}
                onClick={() => setDuration(m)}
                className={`flex-1 py-3 text-sm transition ${
                  duration === m
                    ? "bg-[#191815] text-[#F6F5F2]"
                    : "bg-white/70 text-[#7B7770]"
                }`}
              >
                {m < 60 ? `${m}хв` : `${m / 60}год`}
              </button>
            ))}
          </div>
        </div>
        <div className="mt-3">
          <p className="mb-1 text-xs text-[#7B7770]">Пріоритет</p>
          <div className="flex overflow-hidden rounded-2xl border border-[#E8E5DF]">
            {(["high", "medium", "low"] as Priority[]).map((p) => (
              <button
                key={p}
                onClick={() => setPriority(p)}
                className={`flex-1 py-3 text-sm transition ${
                  priority === p
                    ? "bg-[#191815] text-[#F6F5F2]"
                    : "bg-white/70 text-[#7B7770]"
                }`}
              >
                {PRIORITY_LABEL[p]}
              </button>
            ))}
          </div>
        </div>
        <button
          onClick={() => {
            const finalTitle = title.trim() || task.title;
            if (!finalTitle) return;
            onSave({
              ...task,
              title: finalTitle,
              time: time || null,
              deadline: deadline || null,
              priority,
              duration,
              list: priority === "high" ? "today" : task.list,
            });
          }}
          className="mt-4 w-full rounded-2xl bg-[#191815] py-4 text-[15px] font-medium text-[#F6F5F2] transition active:scale-[0.98]"
        >
          Зберегти
        </button>
        <div className="mt-2 flex gap-2">
          {!isNew &&
            (task.list === "today" ? (
              <button
                onClick={() => onPostpone(task.id)}
                className="flex-1 rounded-2xl border border-[#E8E5DF] py-3.5 text-sm text-[#7B7770] transition active:scale-[0.98]"
              >
                Відкласти на потім
              </button>
            ) : (
              <button
                onClick={() => onMoveToday(task.id)}
                className="flex-1 rounded-2xl border border-[#C88A4E]/50 py-3.5 text-sm font-medium text-[#B5793A] transition active:scale-[0.98]"
              >
                Взяти в Мій день
              </button>
            ))}
          <button
            onClick={() => onDelete(task.id)}
            className="flex-1 rounded-2xl border border-[#E8E5DF] py-3.5 text-sm text-[#A8402F] transition active:scale-[0.98]"
          >
            {isNew ? "Скасувати" : "Видалити"}
          </button>
        </div>
      </div>
    </div>
  );
}
