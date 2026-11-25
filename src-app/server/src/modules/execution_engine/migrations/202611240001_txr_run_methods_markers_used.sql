-- execution_engine module — the markers a no-list method of a learn run was
-- given (single-marker-choice round 1a): the run's ONE marker ranking supplies
-- a no-list method (single / multi k / any with no fixed list) its marker set;
-- the engine records it on the method row so the F screen, the results and a
-- later audit can show what the method actually used. The value is a JSON
-- array of the main marker names; NULL = not recorded (a fixed-list method, a
-- reuse/predict run, an older row, or a no-list method that never ran).

ALTER TABLE txr_run_methods ADD COLUMN markers_used TEXT;
