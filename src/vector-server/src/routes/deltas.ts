import { Router } from 'express';
import { buildAccessContext } from '../accessControl';
import { DeltaUnavailableError, fetchDeltaRecords } from '../deltaRecords';
import authorize, { type AuthorizedLocals } from '../middleware/authorize';
import dosProtect from '../middleware/dosProtect';
import { databaseReader } from './adminDatabase';

const router = Router();

/** Delta build records show every image the stack has served, so they follow the same rule as other global administration. */
router.get('/deltas/records', ...dosProtect, authorize, async (req, res) => {
  try {
    const context = await buildAccessContext((res.locals as AuthorizedLocals).auth, databaseReader(req.headers.authorization!));
    if (context.enforcementEnabled && !context.globalAdmin) {
      res.status(403).json({ message: 'Delta records require a global administrator.' });
      return;
    }
    res.json({ records: await fetchDeltaRecords() });
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : 'Unable to load delta records.';
    res.status(error instanceof DeltaUnavailableError ? 502 : 500).json({ message });
  }
});

export default router;
