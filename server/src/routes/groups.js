import { Router } from 'express'
import { auth } from '../middleware/auth.js'
import { teacherOnly } from '../middleware/teacher.js'
import {
  listCourseGroups,
  createGroup,
  updateGroup,
  removeGroup,
  listAssignmentGroups,
  snapshotGroups,
  setGroupSubmitter,
} from '../services/groupService.js'

const router = Router()
router.get('/courses/:id/groups', auth, (req, res) =>
  res.json(listCourseGroups(req.params.id, req.user)),
)
router.post('/courses/:id/groups', auth, teacherOnly, (req, res) =>
  res.status(201).json(createGroup(req.params.id, req.user, req.body)),
)
router.put('/groups/:id', auth, teacherOnly, (req, res) =>
  res.json(updateGroup(req.params.id, req.user, req.body)),
)
router.delete('/groups/:id', auth, teacherOnly, (req, res) =>
  res.json(removeGroup(req.params.id, req.user)),
)
router.get('/assignments/:id/groups', auth, (req, res) =>
  res.json(listAssignmentGroups(req.params.id, req.user)),
)
router.post('/assignments/:id/groups/snapshot', auth, teacherOnly, (req, res) =>
  res.json(snapshotGroups(req.params.id, req.user, req.body.group_ids)),
)
router.put('/assignment-groups/:id/submitter', auth, teacherOnly, (req, res) =>
  res.json(setGroupSubmitter(req.params.id, req.user, req.body.submitter_id)),
)
export default router
