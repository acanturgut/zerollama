import { Router, Request, Response } from 'express';
import {
  listSessions,
  createSession,
  getSession,
  deleteSession,
  renameSession,
  setActiveSession,
  getActiveSessionId,
  clearSessionMessages,
  getOrCreateActiveSession,
} from '../services/sessions';

const router = Router();

// List all sessions
router.get('/api/sessions', (_req: Request, res: Response) => {
  const sessions = listSessions();
  const activeId = getActiveSessionId();
  res.json({ sessions, activeSessionId: activeId });
});

// Create a new session
router.post('/api/sessions', (req: Request, res: Response) => {
  const { name } = req.body ?? {};
  const session = createSession(name);
  res.status(201).json(session);
});

// Get active session
router.get('/api/sessions/active', (_req: Request, res: Response) => {
  const session = getOrCreateActiveSession();
  res.json(session);
});

// Set active session
router.put('/api/sessions/active', (req: Request, res: Response) => {
  const { id } = req.body ?? {};
  if (!id || typeof id !== 'string') {
    res.status(400).json({ error: 'Missing required field: id' });
    return;
  }
  const ok = setActiveSession(id);
  if (!ok) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  res.json({ activeSessionId: id });
});

// Get a single session
router.get('/api/sessions/:id', (req: Request, res: Response) => {
  const session = getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  res.json(session);
});

// Rename a session
router.patch('/api/sessions/:id', (req: Request, res: Response) => {
  const { name } = req.body ?? {};
  if (!name || typeof name !== 'string') {
    res.status(400).json({ error: 'Missing required field: name' });
    return;
  }
  const ok = renameSession(req.params.id, name);
  if (!ok) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  res.json({ id: req.params.id, name });
});

// Delete a session
router.delete('/api/sessions/:id', (req: Request, res: Response) => {
  const ok = deleteSession(req.params.id);
  if (!ok) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  res.json({ deleted: true });
});

// Clear session messages
router.delete('/api/sessions/:id/messages', (req: Request, res: Response) => {
  const ok = clearSessionMessages(req.params.id);
  if (!ok) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  res.json({ cleared: true });
});

export default router;
