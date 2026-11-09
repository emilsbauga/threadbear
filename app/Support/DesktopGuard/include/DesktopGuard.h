#import <Foundation/Foundation.h>

/// Process-local protection for tests and scripted debug apps. Install before opening windows.
void TBInstallDesktopGuard(void);
BOOL TBDesktopGuardInstalled(void);
