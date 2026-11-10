# 032 — Add bilingual permission denial

The adapter status denied means the OS refused screen capture permission.
Show { state: 'denied', label, actionEnabled: false } using
Screen recording permission denied in English and 屏幕录制权限被拒绝 in Chinese.
Do not call capture for denied status. If the OS denies during a capture after
a previously available probe, the adapter rejects with code PERMISSION_DENIED.
Return the same denial state and never show raw error text. Other adapter failures
continue to reject. Preserve the available and unavailable behavior.
