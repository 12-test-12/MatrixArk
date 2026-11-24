import { useEffect, useRef, useState } from 'react';
import { api, messageOf } from './api';

type Draft = { value: string; error?: string; pending: boolean };
type Edit = { value: string; timer?: number; saving: boolean };

export function useTopicNotes(path: string) {
  const edits = useRef(new Map<string, Edit>());
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});

  async function save(id: string, edit: Edit) {
    if (edit.saving) return;
    edit.saving = true;
    const value = edit.value;
    let error: string | undefined;
    try { await api(path + '/' + id, { method: 'PATCH', body: { note: value }, keepalive: true }); }
    catch (failure) { error = messageOf(failure); }
    finally { edit.saving = false; }

    if (edit.timer !== undefined) return;
    if (edit.value !== value) { void save(id, edit); return; }
    setDrafts((current) => ({ ...current, [id]: { value, pending: false, error } }));
  }

  function flush(id: string, edit: Edit) {
    window.clearTimeout(edit.timer);
    edit.timer = undefined;
    void save(id, edit);
  }

  function change(id: string, value: string, immediate = false) {
    const edit = edits.current.get(id) ?? { value, saving: false };
    edits.current.set(id, edit);
    edit.value = value;
    setDrafts((current) => ({ ...current, [id]: { value, pending: true } }));
    if (immediate) flush(id, edit);
    else {
      window.clearTimeout(edit.timer);
      edit.timer = window.setTimeout(() => flush(id, edit), 500);
    }
  }

  useEffect(() => () => {
    for (const [id, edit] of edits.current) if (edit.timer !== undefined) flush(id, edit);
  }, []);

  return { drafts, change };
}
