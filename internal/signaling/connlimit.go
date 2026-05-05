package signaling

import (
	"time"

	"golang.org/x/time/rate"
)

// connLimiter is a per-connection token-bucket. Cheaper than a full keyed
// limiter when there's exactly one bucket per connection.
type connLimiter struct {
	limiter *rate.Limiter
	now     func() time.Time
}

func newConnLimiter(perSec float64, burst int, now func() time.Time) *connLimiter {
	return &connLimiter{
		limiter: rate.NewLimiter(rate.Limit(perSec), burst),
		now:     now,
	}
}

func (l *connLimiter) Allow() bool {
	return l.limiter.AllowN(l.now(), 1)
}
