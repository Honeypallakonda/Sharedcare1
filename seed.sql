INSERT INTO vitals (circle_id, type, value, unit, measured_at)
SELECT c.id, v.t, v.val, v.u, NOW() - (v.d || ' days')::interval
FROM (SELECT id FROM care_circles LIMIT 1) c,
(VALUES ('weight',70,'kg',12),('weight',70.5,'kg',10),('weight',69.8,'kg',9),
('weight',62,'kg',5),('weight',62.4,'kg',3),('weight',61.8,'kg',1),
('pain',2,'/10',12),('pain',2,'/10',9),('pain',6,'/10',4),('pain',7,'/10',1)) AS v(t,val,u,d);
