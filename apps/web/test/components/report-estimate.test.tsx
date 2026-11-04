import { render, screen } from '@testing-library/react';
import { ReportEstimate, type Estimate } from '~/components/report-estimate';

const estimate = (over: Partial<Estimate> = {}): Estimate => ({
  cached: false,
  summaryCount: 3,
  developerCount: 2,
  estimateUsd: 0.0512,
  spentUsd: 1.25,
  capUsd: 10,
  since: '2026-11-01',
  fits: true,
  canWrite: true,
  ...over,
});

describe('ReportEstimate', () => {
  it('shows the estimate and where the monthly cap stands before anything is written', () => {
    render(<ReportEstimate estimate={estimate()} />);
    expect(screen.getByText('About $0.05')).toBeInTheDocument();
    expect(screen.getByText('$1.25 of $10.00 spent since 2026-11-01')).toBeInTheDocument();
    expect(screen.getByText('3 summaries from 2 developers')).toBeInTheDocument();
    expect(screen.getByText('Fits under the cap')).toHaveAttribute('data-tone', 'safe');
  });

  it('says a cached report is free, and why a report can not be written', () => {
    const { rerender } = render(<ReportEstimate estimate={estimate({ cached: true, estimateUsd: 0 })} />);
    expect(screen.getByText('Already written: free')).toBeInTheDocument();
    rerender(<ReportEstimate estimate={estimate({ fits: false, canWrite: false, spentUsd: 9.99 })} />);
    expect(screen.getByText('Over the monthly cap')).toHaveAttribute('data-tone', 'attention');
    rerender(<ReportEstimate estimate={estimate({ canWrite: false })} />);
    expect(screen.getByText('The server has no API key, so it can only show reports it has already written.')).toBeInTheDocument();
    rerender(<ReportEstimate estimate={estimate({ summaryCount: 0, developerCount: 0, estimateUsd: 0 })} />);
    expect(screen.getByText('No shared summaries in this period')).toBeInTheDocument();
  });
});
