"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";

export type DraftAssignment = {
  id: string;
  ship_mmsi: number;
  ship_name: string;
  cruise_line: string;
  date_start: string;
  date_end: string;
  created_at: string;
  assignee?: string;
  status?: string;
  notes?: string;
  created_by?: string;
};

type Ctx = {
  drafts: DraftAssignment[];
  loading: boolean;
  addDraft: (d: DraftAssignment) => void;
  removeDraft: (id: string) => void;
  reload: () => void;
};

const AssignmentCtx = createContext<Ctx>({
  drafts: [],
  loading: false,
  addDraft: () => {},
  removeDraft: () => {},
  reload: () => {},
});

async function fetchAssignments(): Promise<DraftAssignment[]> {
  const res = await fetch("/api/sheets/assignments/get", { credentials: "include" });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error);
  return json.assignments;
}

export function AssignmentProvider({ children }: { children: React.ReactNode }) {
  const [drafts, setDrafts] = useState<DraftAssignment[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    fetchAssignments()
      .then(setDrafts)
      .catch(e => console.error("[AssignmentContext] fetch failed:", e))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const addDraft = useCallback((d: DraftAssignment) => {
    // Optimistic — prepend immediately, Sheets is source of truth on next reload
    setDrafts(prev => [d, ...prev.filter(x => x.id !== d.id)]);
  }, []);

  const removeDraft = useCallback((id: string) => {
    setDrafts(prev => prev.filter(x => x.id !== id));
  }, []);

  return (
    <AssignmentCtx.Provider value={{ drafts, loading, addDraft, removeDraft, reload: load }}>
      {children}
    </AssignmentCtx.Provider>
  );
}

export function useAssignments() { return useContext(AssignmentCtx); }
