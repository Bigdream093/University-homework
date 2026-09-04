// 重构前的查询，仅用于性能与结果一致性比较。
export const BASELINE_SQL = `SELECT u.id,u.username,u.name,u.status,cs.joined_at,
    ((SELECT count(*) FROM submissions s JOIN assignments a ON a.id=s.assignment_id WHERE a.course_id=cs.course_id AND s.student_id=u.id)
    +(SELECT count(*) FROM group_submissions gs JOIN assignment_groups ag ON ag.id=gs.assignment_group_id JOIN assignments a ON a.id=ag.assignment_id JOIN assignment_group_members gm ON gm.assignment_group_id=ag.id WHERE a.course_id=cs.course_id AND gm.student_id=u.id)) submission_count
    FROM course_students cs JOIN users u ON u.id=cs.student_id WHERE cs.course_id=?
    ORDER BY COALESCE(cs.sort_order, cs.id), cs.id`
