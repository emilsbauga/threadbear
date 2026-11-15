#import <AppKit/AppKit.h>
#import <objc/runtime.h>

// Preserve AppKit ordering/key bookkeeping for scripted controls, suppress
// only desktop presentation. Every window in this process gets the guard,
// including Settings and dialogs opened after launch.
static void (*originalOrder)(id, SEL, NSWindowOrderingMode, NSInteger);
static void (*originalFront)(id, SEL);
static void (*originalAlpha)(id, SEL, CGFloat);
static void (*originalMouse)(id, SEL, BOOL);
static void hide(NSWindow *window) {
    originalAlpha(window, @selector(setAlphaValue:), 0);
    originalMouse(window, @selector(setIgnoresMouseEvents:), YES);
    window.level = NSNormalWindowLevel - 1;
    window.hasShadow = NO;
}
static void order(NSWindow *w, SEL cmd, NSWindowOrderingMode mode, NSInteger relative) { hide(w); originalOrder(w, cmd, mode, relative); }
static void front(NSWindow *w, SEL cmd) { hide(w); originalFront(w, cmd); }
static void alpha(NSWindow *w, SEL cmd, CGFloat value) { (void)value; originalAlpha(w, cmd, 0); }
static void mouse(NSWindow *w, SEL cmd, BOOL value) { (void)value; originalMouse(w, cmd, YES); }
static void activate(id app, SEL cmd) { (void)app; (void)cmd; }
static void activateIgnoring(id app, SEL cmd, BOOL flag) { (void)app; (void)cmd; (void)flag; }

void TBHideTestingWindows(void) {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        originalAlpha = (void *)method_setImplementation(class_getInstanceMethod(NSWindow.class, @selector(setAlphaValue:)), (IMP)alpha);
        originalMouse = (void *)method_setImplementation(class_getInstanceMethod(NSWindow.class, @selector(setIgnoresMouseEvents:)), (IMP)mouse);
        originalOrder = (void *)method_setImplementation(class_getInstanceMethod(NSWindow.class, @selector(orderWindow:relativeTo:)), (IMP)order);
        originalFront = (void *)method_setImplementation(class_getInstanceMethod(NSWindow.class, @selector(orderFrontRegardless)), (IMP)front);
        method_setImplementation(class_getInstanceMethod(NSApplication.class, @selector(activateIgnoringOtherApps:)), (IMP)activateIgnoring);
        Method method = class_getInstanceMethod(NSApplication.class, NSSelectorFromString(@"activate"));
        if (method) method_setImplementation(method, (IMP)activate);
    });
}

bool TBTestingWindowsAreHidden(void) {
    NSUInteger count = 0;
    for (NSWindow *window in NSApp.windows) {
        if (!window.isVisible) continue;
        count++;
        if (window.alphaValue != 0 || !window.ignoresMouseEvents) return false;
    }
    return count > 0;
}
