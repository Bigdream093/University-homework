import { Router } from 'express';
import { auth } from '../middleware/auth.js';
import { teacherOnly } from '../middleware/teacher.js';
import { downloadAssignmentPackage } from '../services/packageService.js';

const router = Router();

router.get('/assignments/:id/package', auth, teacherOnly, (req, res) => {
  downloadAssignmentPackage(req.params.id, req.user.id, res);
});

export default router;
