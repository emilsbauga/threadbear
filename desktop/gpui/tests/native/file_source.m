// Compile alone: importing the implementation exercises TBFileSource with
// AVFoundation's real resource loader, no window. Every read of the open file
// goes through counted_pread below, so the test sees how much was read.
//
// A film's first-frame picture and its player getting ready must read only
// a little of it: answering AVFoundation's "everything to the end" requests
// whole read and held an 8 GB export until the app died (17 Nov), and this
// 30 MB film was read whole (and more) the same way. The film must still read
// back sample for sample, as a short answer would end it early.
//
// The script makes the film with ffmpeg's software encoder: AVAssetWriter's
// hardware encoder, fed noise, panicked the M5's kernel on 17 Nov.
#include <unistd.h>
#include <stdatomic.h>
static _Atomic long long bytes_read;
static ssize_t counted_pread(int fd, void *buffer, size_t count, off_t offset) {
  ssize_t got = pread(fd, buffer, count, offset);
  if (got > 0) {
    atomic_fetch_add(&bytes_read, (long long)got);
  }
  return got;
}
#define pread counted_pread
// A small hold limit, so the test needn't hold 256 MB to reach it.
#define TB_FILE_HELD_LIMIT (8LL * 1024 * 1024)
// And a short wait there before a request fails, long enough for the hold
// test to let go first.
#define TB_FILE_HELD_WAIT_NS (2 * NSEC_PER_SEC)
#import "../../native/media_views.m"
#undef pread
#include <assert.h>
#include <fcntl.h>

void tb_media_said_link(const char *url, const char *base) { (void)url; (void)base; }
void tb_media_said_changed(void) {}
bool tb_media_snapshot(int fd, const char *name, char *out, int capacity) { (void)fd; (void)name; (void)out; (void)capacity; return false; }
int tb_preview_snapshot(int fd, const char *name, char *out, int capacity, uint64_t limit) { (void)fd; (void)name; (void)out; (void)capacity; (void)limit; return 0; }

static void run_until(BOOL (^done)(void)) {
  NSDate *end = [NSDate dateWithTimeIntervalSinceNow:20];
  while (!done()) {
    assert(end.timeIntervalSinceNow > 0 && "AVFoundation never answered");
    [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.02]];
  }
}

static TBFileSource *open_source(NSString *film, long long length) {
  int fd = open(film.fileSystemRepresentation, O_RDONLY);
  assert(fd >= 0);
  return [[TBFileSource alloc] initWithDescriptor:fd length:length path:film];
}

// Stand-ins for AVFoundation's request, asking for everything to the end
// and keeping every byte it's handed, as AVFoundation may.
@class FakeData;
@interface FakeRequest : NSObject
@property(atomic, strong) FakeData *dataRequest;
@property(atomic) BOOL isCancelled;
@property(atomic) BOOL isFinished;
@property(atomic, strong) NSError *failure;
@end
@interface FakeData : NSObject
@property(atomic) long long currentOffset;
@property(atomic, strong) NSMutableArray<NSData *> *kept;
// Off once it's caught up, as AVFoundation lets go of what it's used.
@property(atomic) BOOL keeping;
// Cancels its request once it's been handed this many bytes, from the
// source's own queue, as a cancel landing between two megabytes would.
@property(atomic) long long cancelAt;
@property(atomic, weak) FakeRequest *request;
@end
@implementation FakeData
- (long long)requestedOffset { return 0; }
- (NSInteger)requestedLength { return NSIntegerMax; }
- (BOOL)requestsAllDataToEndOfResource { return YES; }
- (void)respondWithData:(NSData *)data {
  @synchronized(self) {
    if (self.keeping) {
      [self.kept addObject:data];
    }
  }
  self.currentOffset += (long long)data.length;
  if (self.cancelAt && self.currentOffset >= self.cancelAt) {
    [self.request setIsCancelled:YES];
  }
}
@end
@implementation FakeRequest
- (id)contentInformationRequest { return nil; }
- (void)finishLoading { self.isFinished = YES; }
- (void)finishLoadingWithError:(NSError *)error { self.failure = error; }
@end
static FakeRequest *fake_request(void) {
  FakeRequest *request = [FakeRequest new];
  request.dataRequest = [FakeData new];
  request.dataRequest.kept = [NSMutableArray new];
  request.dataRequest.keeping = YES;
  request.dataRequest.request = request;
  return request;
}
// Waits for the source's queue to run what's on it now.
static void settle(TBFileSource *source, double seconds) {
  [NSThread sleepForTimeInterval:seconds];
  dispatch_sync(source.queue, ^{});
}

// Every video sample in the asset, read as stored: no decoder, so all that's
// tested is the bytes coming through.
static int count_samples(AVAsset *asset) {
  __block NSArray<AVAssetTrack *> *tracks = nil;
  __block BOOL loaded = NO;
  [asset loadTracksWithMediaType:AVMediaTypeVideo completionHandler:^(NSArray<AVAssetTrack *> *found, NSError *error) {
    (void)error;
    tracks = found;
    loaded = YES;
  }];
  run_until(^BOOL { return loaded; });
  assert(tracks.count == 1);
  NSError *error = nil;
  AVAssetReader *reader = [AVAssetReader assetReaderWithAsset:asset error:&error];
  assert(reader);
  AVAssetReaderTrackOutput *output = [AVAssetReaderTrackOutput assetReaderTrackOutputWithTrack:tracks[0] outputSettings:nil];
  [reader addOutput:output];
  assert([reader startReading]);
  int samples = 0;
  while (YES) {
    @autoreleasepool {
      CMSampleBufferRef sample = [output copyNextSampleBuffer];
      if (!sample) {
        break;
      }
      samples += (int)CMSampleBufferGetNumSamples(sample);
      CFRelease(sample);
    }
  }
  assert(reader.status == AVAssetReaderStatusCompleted);
  return samples;
}

int main(int argc, char **argv) {
  setbuf(stdout, NULL);
  @autoreleasepool {
    [NSApplication sharedApplication];
    assert(argc == 2 && "usage: file_source <film made by test-media-hover.sh>");
    NSString *film = [NSString stringWithUTF8String:argv[1]];
    struct stat info;
    assert(stat(film.fileSystemRepresentation, &info) == 0);
    long long length = info.st_size;
    assert(length > 16LL * 1024 * 1024 && "the film must be big enough for a whole read to show");

    // A file-link card's picture of the first frame.
    TBFileSource *card = open_source(film, length);
    AVAssetImageGenerator *generator = [AVAssetImageGenerator assetImageGeneratorWithAsset:tb_asset(card, film.lastPathComponent)];
    __block int picture = 0;
    [generator generateCGImagesAsynchronouslyForTimes:@[[NSValue valueWithCMTime:kCMTimeZero]]
                                    completionHandler:^(CMTime requested, CGImageRef image, CMTime actual, AVAssetImageGeneratorResult status, NSError *error) {
                                      (void)requested; (void)actual; (void)error;
                                      picture = status == AVAssetImageGeneratorSucceeded && image ? 1 : -1;
                                    }];
    run_until(^BOOL { return picture != 0; });
    assert(picture == 1);
    long long for_picture = bytes_read;

    // The pane's player, ready to play.
    TBFileSource *pane = open_source(film, length);
    AVPlayerItem *item = [AVPlayerItem playerItemWithAsset:tb_asset(pane, film.lastPathComponent)];
    AVPlayer *player = [AVPlayer playerWithPlayerItem:item];
    player.muted = YES;
    run_until(^BOOL { return item.status != AVPlayerItemStatusUnknown; });
    assert(item.status == AVPlayerItemStatusReadyToPlay);
    // A moment for anything it reads ahead.
    [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:1]];
    long long for_ready = bytes_read - for_picture;
    printf("film %lld bytes: %lld read for the picture, %lld for the player to get ready\n", length, for_picture, for_ready);
    assert(for_picture < length / 4 && "the picture read most of the film");
    assert(for_ready < length / 4 && "the player read most of the film before playing");
    player = nil;
    item = nil;

    // Read back whole, sample for sample, as from the file itself.
    TBFileSource *whole = open_source(film, length);
    int through_source = count_samples(tb_asset(whole, film.lastPathComponent));
    int direct = count_samples([AVURLAsset URLAssetWithURL:[NSURL fileURLWithPath:film] options:@{AVURLAssetReferenceRestrictionsKey : @(AVAssetReferenceRestrictionForbidAll)}]);
    printf("%d samples through the source, %d from the file\n", through_source, direct);
    assert(direct == 90);
    assert(through_source == direct && "the film ended early");
    puts("PASS: a film's picture and player read only what they need, and it still reads back whole");

    // A request for everything to the end that's never cancelled and keeps
    // all it's handed stops at the hold limit, waits while it's held, and
    // finishes once it's let go.
    @autoreleasepool {
      TBFileSource *held = open_source(film, length);
      FakeRequest *request = fake_request();
      BOOL waits = [held resourceLoader:(AVAssetResourceLoader *)(id)request shouldWaitForLoadingOfRequestedResource:(AVAssetResourceLoadingRequest *)request];
      assert(waits);
      settle(held, 0.3);
      long long stopped = request.dataRequest.currentOffset;
      printf("held to %lld bytes of %lld\n", stopped, length);
      assert(stopped >= TB_FILE_HELD_LIMIT && stopped <= TB_FILE_HELD_LIMIT + 1024 * 1024 && !request.isFinished);
      settle(held, 0.2);
      assert(request.dataRequest.currentOffset == stopped && "it read on while all it had was held");
      @synchronized(request.dataRequest) {
        request.dataRequest.keeping = NO;
        [request.dataRequest.kept removeAllObjects];
      }
      run_until(^BOOL { return request.isFinished; });
      assert(request.dataRequest.currentOffset == length && !request.failure);
      puts("PASS: a request that keeps everything stops at the hold limit and finishes once it lets go");
    }

    // Never let go, a request at the hold limit fails once it's waited, and
    // the file closes when the source is let go.
    int fd;
    @autoreleasepool {
      TBFileSource *stuck = open_source(film, length);
      fd = stuck.fd;
      FakeRequest *request = fake_request();
      [stuck resourceLoader:(AVAssetResourceLoader *)(id)request shouldWaitForLoadingOfRequestedResource:(AVAssetResourceLoadingRequest *)request];
      run_until(^BOOL { return request.failure != nil; });
      assert(request.failure.code == ENOMEM && !request.isFinished);
      assert(request.dataRequest.currentOffset == TB_FILE_HELD_LIMIT);
      settle(stuck, 0.1);
      stuck = nil;
      request = nil;
    }
    run_until(^BOOL { return fcntl(fd, F_GETFD) == -1 && errno == EBADF; });
    puts("PASS: a request stuck at the hold limit fails after its wait, and the file closes");

    // Cancelled between two megabytes, a request reads no more, and the
    // file closes when the source is let go.
    @autoreleasepool {
      TBFileSource *cancelled = open_source(film, length);
      fd = cancelled.fd;
      FakeRequest *request = fake_request();
      request.dataRequest.keeping = NO;
      request.dataRequest.cancelAt = 2 * 1024 * 1024;
      [cancelled resourceLoader:(AVAssetResourceLoader *)(id)request shouldWaitForLoadingOfRequestedResource:(AVAssetResourceLoadingRequest *)request];
      settle(cancelled, 0.3);
      assert(request.dataRequest.currentOffset == 2 * 1024 * 1024 && "a cancelled request read on");
      assert(!request.isFinished && !request.failure);
      cancelled = nil;
    }
    run_until(^BOOL { return fcntl(fd, F_GETFD) == -1 && errno == EBADF; });
    puts("PASS: a cancelled request reads no more, and the file closes when the source goes");
  }
  return 0;
}
