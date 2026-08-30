import { createRouter, createWebHistory } from 'vue-router';
import LoginView from '../views/LoginView.vue';
import { readUser } from '../utils/session.js';

const routes = [
  { path: '/', redirect: '/login' },
  { path: '/login', component: LoginView, meta: { public: true } },
  { path: '/password', component: () => import('../views/PasswordView.vue') },
  { path: '/teacher/courses', component: () => import('../views/teacher/TeacherCourses.vue'), meta: { role: 'teacher' } },
  { path: '/teacher/courses/:id', component: () => import('../views/teacher/CourseManage.vue'), meta: { role: 'teacher' } },
  { path: '/teacher/assignments/:id', component: () => import('../views/teacher/SubmissionsView.vue'), meta: { role: 'teacher' } },
  { path: '/student/courses', component: () => import('../views/student/StudentCourses.vue'), meta: { role: 'student' } },
  { path: '/student/courses/:id', component: () => import('../views/student/StudentAssignments.vue'), meta: { role: 'student' } },
  { path: '/student/assignments/:id', component: () => import('../views/student/StudentSubmit.vue'), meta: { role: 'student' } }
];
const router = createRouter({ history: createWebHistory(), routes, scrollBehavior: () => ({ top: 0 }) });
router.beforeEach(to => {
  if (to.meta.public) return true;
  const user = readUser();
  if (!user) return '/login';
  if (to.meta.role && to.meta.role !== user.role) return user.role === 'teacher' ? '/teacher/courses' : '/student/courses';
});
export default router;
