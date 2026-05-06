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
};

type Ctx = {
  drafts: DraftAssignment[];
  addDraft: (d: DraftAssignment) => void;
  removeDraft: (id: string) => void;
};

const AssignmentCtx = createContext<Ctx>({ drafts: [], addDraft: () => {}, removeDraft: () => {} });

const LS_KEY = "ais_draft_assignments";

export function AssignmentProvider({ children }: { children: React.ReactNode }) {
  const [drafts, setDrafts] = useState<DraftAssignment[]>(() => {
    if (typeof window === "undefined") return [];
    try { return JSON.parse(localStorage.getItem(LS_KEY) ?? "[]"); } catch { return []; }
  });

  useEffect(() => {
    localStorage.setItem(LS_KEY, JSON.stringify(drafts));
  }, [drafts]);

  const addDraft = useCallback((d: DraftAssignment) => {
    setDrafts(prev => [d, ...prev.filter(x => x.id !== d.id)]);
  }, []);

  const removeDraft = useCallback((id: string) => {
    setDrafts(prev => prev.filter(x => x.id !== id));
  }, []);

  return <AssignmentCtx.Provider value={{ drafts, addDraft, removeDraft }}>{children}</AssignmentCtx.Provider>;
}

export function useAssignments() { return useContext(AssignmentCtx); }
