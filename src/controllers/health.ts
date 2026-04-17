import { Router, Request, Response } from 'express';
import { OLLAMA_URL } from '../config';
import { checkConnection } from '../services/ollama';

const router = Router();

router.get('/health', async (_req: Request, res: Response) => {
  try {
    const reachable = await checkConnection();
    res.json({ status: 'ok', ollama: OLLAMA_URL, ollamaReachable: reachable });
  } catch {
    res.json({ status: 'ok', ollama: OLLAMA_URL, ollamaReachable: false });
  }
});

export default router;
