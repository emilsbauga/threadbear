// The stage for filming the GPUI app (desktop/scripts/film.sh): a virtual
// display at 2x, with the app's window moved onto it, so a recording is
// Retina-sharp on a Mac whose own screen isn't (Tinker Desk's is 1080p at 1x),
// and nothing ever covers the window (a covered GPUI window gets no frames).
//
//   stage <app pid> <dir> [WxH points, default 1600x1000]
//
// Writes <dir>/stage.json ({"display": id, "window": CGWindowID}) once the
// window is on the display, and keeps the display until <dir>/stage.stop
// appears or the app goes. The display goes with this process. Moving the
// window needs Accessibility, so run it through Desk Runner (`desk`).
//
// CGVirtualDisplay is CoreGraphics' own private class (what Sidecar and the
// virtual-screen apps use); it isn't in the SDK headers, so it's declared
// here and looked up by name.
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <CoreGraphics/CoreGraphics.h>

@interface CGVirtualDisplayDescriptor : NSObject
@property(retain, nonatomic) dispatch_queue_t queue;
@property(retain, nonatomic) NSString *name;
@property(nonatomic) unsigned int maxPixelsHigh;
@property(nonatomic) unsigned int maxPixelsWide;
@property(nonatomic) CGSize sizeInMillimeters;
@property(nonatomic) unsigned int productID;
@property(nonatomic) unsigned int vendorID;
@property(nonatomic) unsigned int serialNum;
@property(copy, nonatomic) void (^terminationHandler)(id, id);
@end
@interface CGVirtualDisplayMode : NSObject
- (instancetype)initWithWidth:(unsigned int)width height:(unsigned int)height refreshRate:(double)rate;
@end
@interface CGVirtualDisplaySettings : NSObject
@property(retain, nonatomic) NSArray *modes;
@property(nonatomic) unsigned int hiDPI;
@end
@interface CGVirtualDisplay : NSObject
- (instancetype)initWithDescriptor:(CGVirtualDisplayDescriptor *)descriptor;
- (BOOL)applySettings:(CGVirtualDisplaySettings *)settings;
@property(readonly, nonatomic) unsigned int displayID;
@end

static void say(NSString *s) {
  fprintf(stdout, "%s\n", s.UTF8String);
  fflush(stdout);
}

// The app's biggest ordinary window: its main one.
static CGWindowID windowOf(pid_t pid, CGRect *frame) {
  CFArrayRef list = CGWindowListCopyWindowInfo(kCGWindowListOptionAll, kCGNullWindowID);
  CGWindowID best = 0;
  double area = 0;
  for (NSDictionary *w in (__bridge NSArray *)list) {
    if ([w[(id)kCGWindowOwnerPID] intValue] != pid || [w[(id)kCGWindowLayer] intValue] != 0) continue;
    CGRect r;
    if (!CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)w[(id)kCGWindowBounds], &r)) continue;
    if (r.size.width * r.size.height > area) {
      area = r.size.width * r.size.height;
      best = [w[(id)kCGWindowNumber] unsignedIntValue];
      if (frame) *frame = r;
    }
  }
  if (list) CFRelease(list);
  return best;
}

int main(int argc, char **argv) {
  @autoreleasepool {
    if (argc < 3) {
      fprintf(stderr, "usage: stage <app pid> <dir> [WxH]\n");
      return 2;
    }
    pid_t pid = atoi(argv[1]);
    NSString *dir = [NSString stringWithUTF8String:argv[2]];
    unsigned int w = 1600, h = 1000;
    if (argc > 3) sscanf(argv[3], "%ux%u", &w, &h);
    [NSApplication sharedApplication];

    Class D = NSClassFromString(@"CGVirtualDisplayDescriptor"), V = NSClassFromString(@"CGVirtualDisplay"),
          S = NSClassFromString(@"CGVirtualDisplaySettings"), M = NSClassFromString(@"CGVirtualDisplayMode");
    if (!D || !V || !S || !M) {
      say(@"error: this macOS has no CGVirtualDisplay");
      return 1;
    }
    CGVirtualDisplayDescriptor *d = [D new];
    d.queue = dispatch_get_main_queue();
    d.name = @"Threadbear filming";
    d.maxPixelsWide = w * 2;
    d.maxPixelsHigh = h * 2;
    // About a 27" screen's pixel density at 2x, so macOS offers the HiDPI mode.
    d.sizeInMillimeters = CGSizeMake(w * 2 * 0.1171, h * 2 * 0.1171);
    d.vendorID = 0x7462;  // "tb"
    d.productID = 0x6669; // "fi"
    d.serialNum = 1;
    d.terminationHandler = ^(id a, id b) { say(@"error: the virtual display was taken away"); exit(1); };
    CGVirtualDisplay *display = [[V alloc] initWithDescriptor:d];
    CGVirtualDisplaySettings *settings = [S new];
    settings.hiDPI = 1;
    settings.modes = @[ [[M alloc] initWithWidth:w height:h refreshRate:60] ];
    if (!display || ![display applySettings:settings]) {
      say(@"error: couldn't make the virtual display");
      return 1;
    }
    CGDirectDisplayID id_ = display.displayID;

    // The window, once the app has one and the display has its mode.
    CGRect bounds = CGRectZero, frame = CGRectZero;
    CGWindowID win = 0;
    for (int i = 0; i < 300; i++) {
      [[NSRunLoop mainRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.1]];
      bounds = CGDisplayBounds(id_);
      win = windowOf(pid, &frame);
      if (win && bounds.size.width >= w) break;
    }
    CGDisplayModeRef mode = CGDisplayCopyDisplayMode(id_);
    size_t px = mode ? CGDisplayModeGetPixelWidth(mode) : 0;
    if (mode) CGDisplayModeRelease(mode);
    say([NSString stringWithFormat:@"display %u at %.0f,%.0f %.0fx%.0f points, %zu pixels wide", id_, bounds.origin.x, bounds.origin.y,
                                   bounds.size.width, bounds.size.height, px]);
    if (!win) {
      say(@"error: the app has no window");
      return 1;
    }
    if (!AXIsProcessTrusted()) {
      say(@"error: no Accessibility permission to move the window (run it through desk)");
      return 1;
    }
    // Moved with Accessibility, as a person dragging it would: centred on the display.
    AXUIElementRef app = AXUIElementCreateApplication(pid);
    CFArrayRef windows = NULL;
    BOOL moved = NO;
    for (int i = 0; i < 50 && !moved; i++) {
      if (windows) CFRelease(windows);
      windows = NULL;
      AXUIElementCopyAttributeValue(app, kAXWindowsAttribute, (CFTypeRef *)&windows);
      win = windowOf(pid, &frame);
      CGPoint to = CGPointMake(bounds.origin.x + floor((bounds.size.width - frame.size.width) / 2),
                               bounds.origin.y + floor((bounds.size.height - frame.size.height) / 2));
      for (CFIndex n = 0; windows && n < CFArrayGetCount(windows); n++) {
        AXUIElementRef aw = CFArrayGetValueAtIndex(windows, n);
        CGSize size;
        AXValueRef v = NULL;
        if (AXUIElementCopyAttributeValue(aw, kAXSizeAttribute, (CFTypeRef *)&v) != kAXErrorSuccess) continue;
        AXValueGetValue(v, kAXValueCGSizeType, &size);
        CFRelease(v);
        if (fabs(size.width - frame.size.width) > 1 || fabs(size.height - frame.size.height) > 1) continue;
        AXValueRef p = AXValueCreate(kAXValueCGPointType, &to);
        AXUIElementSetAttributeValue(aw, kAXPositionAttribute, p);
        CFRelease(p);
        AXUIElementPerformAction(aw, kAXRaiseAction);
      }
      [[NSRunLoop mainRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.2]];
      windowOf(pid, &frame);
      moved = CGRectContainsRect(bounds, frame);
    }
    if (windows) CFRelease(windows);
    CFRelease(app);
    if (!moved) {
      say(@"error: couldn't move the window onto the display");
      return 1;
    }
    NSString *json = [NSString stringWithFormat:@"{\"display\":%u,\"window\":%u,\"x\":%.0f,\"y\":%.0f,\"w\":%.0f,\"h\":%.0f,\"pixelsWide\":%zu}\n", id_, win,
                                                frame.origin.x, frame.origin.y, frame.size.width, frame.size.height, px];
    [json writeToFile:[dir stringByAppendingPathComponent:@"stage.json"] atomically:YES encoding:NSUTF8StringEncoding error:nil];
    say([NSString stringWithFormat:@"window %u on it at %.0fx%.0f", win, frame.size.width, frame.size.height]);
    NSString *stop = [dir stringByAppendingPathComponent:@"stage.stop"];
    while (![[NSFileManager defaultManager] fileExistsAtPath:stop] && kill(pid, 0) == 0) {
      [[NSRunLoop mainRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.5]];
    }
    [[NSFileManager defaultManager] removeItemAtPath:stop error:nil];
    say(@"stage down");
  }
  return 0;
}
