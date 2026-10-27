// ---- Tutor ----

export type ReplyAssessment = 'correct' | 'partial' | 'misconception' | 'dont_know' | 'none';
export type HintLevel = 1 | 2 | 3;

/** The kind of problem, so myTA can adapt how it reads the work and what it watches for. */
export type Domain = 'algebra' | 'calculus' | 'geometry' | 'statistics' | 'physics' | 'circuits' | 'chemistry' | 'linear_algebra' | 'programming' | 'logic' | 'other';

/** What the student's work is likely to look like on screen. */
export type WorkFormat = 'equations' | 'diagram' | 'code' | 'text' | 'mixed';

/** One milestone on the way to the answer (private: a value here is as secret as the final answer). */
export interface Checkpoint {
  label: string;
  expected: string;
}

export interface SolverResult {
  problemText: string;
  finalAnswer: string;
  /** Every equivalent way a correct final answer may be written ("infinitely many solutions", "all real numbers", "x ∈ ℝ"). */
  answerForms?: string[];
  keySteps: string[];
  conceptTags: string[];
  misconceptions: string[];
  answerKeyPhrases: string[];
  problemDetected: boolean;
  /** 1 (one quick step) to 5 (long and hard) for a typical student. */
  difficulty?: number;
  /** What kind of problem it is ("node voltage analysis"), and the broad subject area. */
  problemKind?: string;
  domain?: Domain;
  /** What the student's work will look like: equations, a diagram they annotate, code, prose, or a mix. */
  workFormat?: WorkFormat;
  /** Everything given in a figure or table, in words, so the figure doesn't have to be re-read every time. */
  givens?: string;
  /** Milestones on the way to the answer, in order: how a half-finished solution is judged. */
  checkpoints?: Checkpoint[];
  /** How sure the answer key is. When low, a student's different answer isn't called wrong without finding the actual slip. */
  keyConfidence?: 'high' | 'medium' | 'low';
  /** How long a typical student needs for this problem, in minutes. */
  expectedMinutes?: number;
  /** What the page is: problems to solve, only notes, notes with problems, or nothing. */
  pageKind?: 'problem' | 'notes' | 'mixed' | 'nothing';
  /** Every problem on the page the student could be on (labels and short summaries, never answers). */
  candidates?: ProblemCandidate[];
  /** True when there are several and nothing shows which one: the student is asked. */
  ambiguous?: boolean;
  /** The one concept a short video should explain if the student is lost, and a YouTube search for it (never the problem itself). */
  videoConcept?: string;
  videoQuery?: string;
}

/** A problem on the page: what the page calls it, what it asks in a few words, and whether the student's working for it is on screen. */
export interface ProblemCandidate {
  label: string;
  summary: string;
  studentWorking: boolean;
}

export interface ChatMessage {
  role: 'tutor' | 'student';
  text: string;
  t: number;
}

/** `hint`: the student pressed "Hint" (point me in the right direction). `another`: they pressed it again after a hint. */
export type TutorAction = 'hint' | 'another';

// ---- Work watching ----

export type WorkStatus = 'unknown' | 'no_work' | 'on_track' | 'possible_mistake' | 'solved' | 'different_problem';

/** How well the model could read what the student has written. */
export type Readability = 'clear' | 'hard_to_read' | 'nothing_written';

/** Private notes about the student's work. `observation` may name the mistake, so it never goes to the UI. */
export interface WorkState {
  status: WorkStatus;
  observation: string;
  reviewedAt: number;
  read?: string;
  readability?: Readability;
  copiedWrong?: boolean;
  copyState?: CopyState;
}

/** How far the student is with copying the problem onto their work. A copy can only be called wrong once it is `complete`. */
export type CopyState = 'not_copied' | 'in_progress' | 'complete';

/** [ymin, xmin, ymax, xmax], each 0..1000 (the bounding-box convention vision models use). */
export type Box = [number, number, number, number];

export type CheckVerdict = 'correct' | 'mistake' | 'incomplete' | 'unclear';

/** What kind of mistake: a wrong step in the working, a wrong final answer, or the problem copied down differently from how it is given. */
export type MistakeKind = 'step' | 'answer' | 'copy';

export interface TutorTurn {
  replyAssessment: ReplyAssessment;
  hintLevel: HintLevel;
  message: string;
  missingPrerequisite: string;
}

export interface VideoMoment {
  videoId: string;
  title: string;
  channel: string;
  start: number; // seconds
  end: number;
  why: string;
  concept: string;
  /** Where the moment came from: the video's chapters, Gemini watching the video, the search result's text, or a cached moment. */
  source: 'chapters' | 'video' | 'metadata' | 'cache';
  practice?: { title: string; link: string; site: string }[];
  lengthSec?: number;
  thumb?: string;
}
