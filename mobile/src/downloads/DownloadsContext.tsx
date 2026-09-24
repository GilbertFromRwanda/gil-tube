import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { cancelJob, getJob, getJobProgress } from '../api/client';
import { Job, JobProgress, JobStatus } from '../api/types';

export interface DownloadItem {
  jobId: string;
  title: string;
  container?: string;
  job: Job;
  progress: JobProgress | null;
}

const TERMINAL: JobStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED'];

// job.status is the coarse DB-tracked state; progress.status carries the
// downloader's live sub-phase (DOWNLOADING vs MUXING) while a job is in
// flight, so prefer it until the job is terminal.
export function displayStatusOf(item: DownloadItem): JobStatus {
  return item.job.status === 'DOWNLOADING' && item.progress?.status ? item.progress.status : item.job.status;
}

export function isActive(item: DownloadItem): boolean {
  return !TERMINAL.includes(item.job.status);
}

interface DownloadsValue {
  items: DownloadItem[];
  track: (job: Job, title: string) => void;
  cancel: (jobId: string) => Promise<void>;
  dismiss: (jobId: string) => void;
}

const DownloadsContext = createContext<DownloadsValue | null>(null);

// App-level owner of download jobs, so progress survives the preview sheet
// being closed. One shared poller updates every unfinished job once a
// second (rather than each view polling on its own) and stops when nothing
// is running.
export function DownloadsProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<DownloadItem[]>([]);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const hasActive = items.some(isActive);

  const pollAll = useCallback(async () => {
    const running = itemsRef.current.filter(isActive);
    if (running.length === 0) return;

    const updates = await Promise.all(
      running.map(async (item) => {
        try {
          const [job, progress] = await Promise.all([getJob(item.jobId), getJobProgress(item.jobId)]);
          return { jobId: item.jobId, job, progress };
        } catch (err) {
          // Transient network hiccup; the next tick tries again.
          return null;
        }
      }),
    );

    setItems((prev) =>
      prev.map((item) => {
        const update = updates.find((u) => u && u.jobId === item.jobId);
        return update ? { ...item, job: update.job, progress: update.progress } : item;
      }),
    );
  }, []);

  useEffect(() => {
    if (!hasActive) return;
    pollAll();
    const timer = setInterval(pollAll, 1000);
    return () => clearInterval(timer);
  }, [hasActive, pollAll]);

  const track = useCallback((job: Job, title: string) => {
    setItems((prev) => [
      { jobId: job.job_id, title, container: job.container, job, progress: null },
      ...prev.filter((item) => item.jobId !== job.job_id),
    ]);
  }, []);

  const cancel = useCallback(async (jobId: string) => {
    try {
      await cancelJob(jobId);
    } catch (err) {
      // Ignore: the next poll tick reflects whatever state actually won.
    }
  }, []);

  const dismiss = useCallback((jobId: string) => {
    setItems((prev) => prev.filter((item) => item.jobId !== jobId));
  }, []);

  const value = useMemo(() => ({ items, track, cancel, dismiss }), [items, track, cancel, dismiss]);

  return <DownloadsContext.Provider value={value}>{children}</DownloadsContext.Provider>;
}

export function useDownloads(): DownloadsValue {
  const ctx = useContext(DownloadsContext);
  if (!ctx) throw new Error('useDownloads must be used within a DownloadsProvider');
  return ctx;
}
