---
name: HIL report
description: Turn a HIL campaign result into the team's report format
---
Write the campaign report in this order:
1. Summary line: bench, ECU software version, pass/fail counts.
2. New failures since the last campaign, each with the CANoe test module, the failing step and a Jazz defect ID (or "no defect yet").
3. Requirements without coverage.
Keep it under one page. Use `collect-logs.py` (listed in this plugin's scripts) to gather the CANoe logs first.
