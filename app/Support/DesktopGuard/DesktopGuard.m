#import <AppKit/AppKit.h>
#import <objc/runtime.h>
#import "DesktopGuard.h"

// Keep AppKit's real ordering and key-window bookkeeping: SwiftUI buttons
// need those even when events are sent directly to a test window. Only the
// desktop presentation is suppressed. No change reaches another process.
static void (*originalOrder)(id, SEL, NSWindowOrderingMode, NSInteger);
static void (*originalFront)(id, SEL);
static void (*originalAlpha)(id, SEL, CGFloat);
static void (*originalMouse)(id, SEL, BOOL);

static void hideWindow(NSWindow *window) {
    originalAlpha(window, @selector(setAlphaValue:), 0);
    originalMouse(window, @selector(setIgnoresMouseEvents:), YES);
    window.level = NSNormalWindowLevel - 1;
    window.hasShadow = NO;
}

static void orderHidden(NSWindow *window, SEL cmd, NSWindowOrderingMode mode, NSInteger relativeTo) {
    hideWindow(window);
    originalOrder(window, cmd, mode, relativeTo);
}

static void frontHidden(NSWindow *window, SEL cmd) {
    hideWindow(window);
    originalFront(window, cmd);
}

static void keepClear(NSWindow *window, SEL cmd, CGFloat alpha) { originalAlpha(window, cmd, 0); }
static void ignoreMouse(NSWindow *window, SEL cmd, BOOL ignore) { originalMouse(window, cmd, YES); }
static void refuseActivation(id app, SEL cmd) {}
static void refuseActivationIgnoringOthers(id app, SEL cmd, BOOL flag) {}

BOOL TBDesktopGuardInstalled(void) {
    return originalOrder != NULL
        && method_getImplementation(class_getInstanceMethod(NSWindow.class, @selector(orderWindow:relativeTo:))) == (IMP)orderHidden
        && method_getImplementation(class_getInstanceMethod(NSWindow.class, @selector(orderFrontRegardless))) == (IMP)frontHidden
        && method_getImplementation(class_getInstanceMethod(NSWindow.class, @selector(setAlphaValue:))) == (IMP)keepClear
        && method_getImplementation(class_getInstanceMethod(NSWindow.class, @selector(setIgnoresMouseEvents:))) == (IMP)ignoreMouse
        && method_getImplementation(class_getInstanceMethod(NSApplication.class, @selector(activateIgnoringOtherApps:))) == (IMP)refuseActivationIgnoringOthers;
}

void TBInstallDesktopGuard(void) {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        originalAlpha = (void *)method_setImplementation(class_getInstanceMethod(NSWindow.class, @selector(setAlphaValue:)), (IMP)keepClear);
        originalMouse = (void *)method_setImplementation(class_getInstanceMethod(NSWindow.class, @selector(setIgnoresMouseEvents:)), (IMP)ignoreMouse);
        originalOrder = (void *)method_setImplementation(class_getInstanceMethod(NSWindow.class, @selector(orderWindow:relativeTo:)), (IMP)orderHidden);
        originalFront = (void *)method_setImplementation(class_getInstanceMethod(NSWindow.class, @selector(orderFrontRegardless)), (IMP)frontHidden);
        method_setImplementation(class_getInstanceMethod(NSApplication.class, @selector(activateIgnoringOtherApps:)), (IMP)refuseActivationIgnoringOthers);
        Method activate = class_getInstanceMethod(NSApplication.class, NSSelectorFromString(@"activate"));
        if (activate) method_setImplementation(activate, (IMP)refuseActivation);
    });
}
