// SPDX-License-Identifier: AGPL-3.0-only
//
// DS-PRIM-17, the icon (MP-1-2).
//
// The mockup draws Flaticon's regular-rounded icon font. That set is not
// shipped: its free licence cannot pass to the people this product is given
// to (TICKET-PLAN R52). Lucide (ISC) replaces it, chosen because its glyphs are
// stroked with round caps and joins, the nearest open set to the regular
// rounded style. The keys below are the mockup's glyph names without their
// icon-font prefix, so a catalogue entry that names a glyph finds it here, and
// the list is exactly the glyphs the mockup draws.
//
// Every glyph inherits `currentColor`. An icon with no `label` is decoration
// and is hidden from assistive technology; one with a label is an image with
// that name.

import type { LucideIcon } from 'lucide-react';
import {
  Activity,
  AppWindow,
  ArrowLeftRight,
  ArrowRight,
  Bell,
  Briefcase,
  Calendar,
  ChartColumn,
  ChartNoAxesColumnIncreasing,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsDown,
  ChevronsLeft,
  ChevronsRight,
  ChevronsUp,
  ChevronUp,
  Clock,
  Code,
  Coins,
  Download,
  Eye,
  FilePen,
  FileText,
  Folder,
  FolderOpen,
  Funnel,
  Globe,
  HandHeart,
  Handshake,
  Headphones,
  House,
  Image,
  LayoutDashboard,
  LayoutGrid,
  Link,
  ListChecks,
  Lock,
  Mail,
  MapPin,
  Megaphone,
  MessageSquare,
  MessagesSquare,
  MoveHorizontal,
  Package,
  Palette,
  Pencil,
  Play,
  Plug,
  Plus,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Search,
  Share2,
  SlidersHorizontal,
  Sparkles,
  SquareArrowOutUpRight,
  SquarePen,
  Star,
  Target,
  ThumbsUp,
  Undo2,
  User,
  Users,
  Video,
  X,
  Zap,
} from 'lucide-react';
import type { ReactElement } from 'react';

const GLYPHS = {
  'angle-double-left': ChevronsLeft,
  'angle-double-right': ChevronsRight,
  'angle-double-small-down': ChevronsDown,
  'angle-double-small-up': ChevronsUp,
  'angle-small-down': ChevronDown,
  'angle-small-left': ChevronLeft,
  'angle-small-right': ChevronRight,
  'angle-small-up': ChevronUp,
  apps: LayoutGrid,
  'arrow-small-right': ArrowRight,
  'arrow-up-right-from-square': SquareArrowOutUpRight,
  'arrows-h': MoveHorizontal,
  bell: Bell,
  bolt: Zap,
  box: Package,
  briefcase: Briefcase,
  browser: AppWindow,
  calendar: Calendar,
  'chart-histogram': ChartColumn,
  check: Check,
  clock: Clock,
  'code-simple': Code,
  coins: Coins,
  'comment-alt': MessageSquare,
  comments: MessagesSquare,
  'cross-small': X,
  document: FileText,
  download: Download,
  edit: SquarePen,
  envelope: Mail,
  exchange: ArrowLeftRight,
  eye: Eye,
  'file-edit': FilePen,
  filter: Funnel,
  folder: Folder,
  'folder-open': FolderOpen,
  globe: Globe,
  handshake: Handshake,
  headphones: Headphones,
  home: House,
  'layout-fluid': LayoutDashboard,
  link: Link,
  'list-check': ListChecks,
  lock: Lock,
  marker: MapPin,
  megaphone: Megaphone,
  palette: Palette,
  pencil: Pencil,
  picture: Image,
  play: Play,
  plug: Plug,
  plus: Plus,
  pulse: Activity,
  refresh: RefreshCw,
  'rotate-left': RotateCcw,
  'rotate-right': RotateCw,
  search: Search,
  'settings-sliders': SlidersHorizontal,
  share: Share2,
  sparkles: Sparkles,
  star: Star,
  stats: ChartNoAxesColumnIncreasing,
  target: Target,
  'thumbs-up': ThumbsUp,
  'thumbs-up-trust': HandHeart,
  undo: Undo2,
  user: User,
  users: Users,
  'video-camera-alt': Video,
} as const satisfies Readonly<Record<string, LucideIcon>>;

export type GlyphName = keyof typeof GLYPHS;
export const GLYPH_NAMES = Object.keys(GLYPHS) as readonly GlyphName[];

export interface IconProps {
  readonly name: GlyphName;
  /** The accessible name. Leave it out when the words beside the icon say it. */
  readonly label?: string;
  /** DS-TOK-102 to DS-TOK-105. */
  readonly size?: 'xs' | 'sm' | 'md' | 'lg';
}

export function Icon(props: IconProps): ReactElement {
  const Glyph = GLYPHS[props.name];
  const labelled = props.label !== undefined;
  return (
    <Glyph
      className={`icon icon--${props.size ?? 'md'}`}
      // The size comes from the class; Lucide's own 24px attributes are overridden there.
      strokeWidth={1.75}
      aria-hidden={labelled ? undefined : true}
      aria-label={props.label}
      role={labelled ? 'img' : undefined}
      focusable="false"
    />
  );
}
