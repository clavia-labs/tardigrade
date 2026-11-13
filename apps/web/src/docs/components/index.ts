import { LibraryJigsaw } from "../diagrams/LibraryJigsaw"
import { LibraryLayersDiagram } from "../diagrams/LibraryLayersDiagram"
import { WorkspaceDeploymentDiagram } from "../diagrams/WorkspaceDeploymentDiagram"
import { AgentServicesDiagram } from "../diagrams/AgentServicesDiagram"
import { NotesList } from "./NotesList"
import { AuthorAvatar } from "../../notes/AuthorAvatar"
import { Dialogue, Socrates, You } from "../../notes/Dialogue"
import { AgentViewDiagram } from "../../notes/diagrams/AgentViewDiagram"
import { CaveDiagram } from "../../notes/diagrams/CaveDiagram"
import { FlyingTardie } from "../../notes/diagrams/FlyingTardie"
import { MergeDiagram } from "../../notes/diagrams/MergeDiagram"
import { RussianDollDiagram } from "../../notes/diagrams/RussianDollDiagram"
import { ShadowDiagram } from "../../notes/diagrams/ShadowDiagram"
import { DurableAtomDiagram, DurableAtomFamilyDiagram, DurableAtomLogDiagram, EffectAtomDiagram } from "../playgrounds/AtomPlaygroundDiagram"
import { CodePlayground } from "../playgrounds/CodePlayground"
import { AtomSpreadsheet } from "../playgrounds/AtomSpreadsheet"
import { StorageLayoutDiagram } from "../diagrams/actors/StorageLayoutDiagram"
import { InstallCommand } from "./InstallCommand"
import { EventLogWorldDiagram } from "../diagrams/EventLogWorldDiagram"
import { WorldObservationDiagram } from "../diagrams/verification/WorldObservationDiagram"
import { StateInitialisationDiagram } from "../diagrams/StateInitialisationDiagram"
import { StateSpaceSamplingDiagram } from "../diagrams/verification/StateSpaceSamplingDiagram"
import { FactoryCounterexampleDiagram } from "../diagrams/verification/FactoryCounterexampleDiagram"
import { FactoryDiversionDiagram } from "../diagrams/verification/FactoryDiversionDiagram"
import { VerificationResultsDiagram } from "../diagrams/verification/VerificationResultsDiagram"
import { FactoryPathGenerator } from "../diagrams/verification/FactoryPathGenerator"
import { ClippieToolsDiagram } from "../diagrams/verification/ClippieToolsDiagram"
import { FactoryToolsDiagram } from "../diagrams/verification/FactoryPathsDiagram"
import { PaperclipProblemDiagram } from "../diagrams/verification/PaperclipProblemDiagram"
import { VerificationPathsDiagram } from "../diagrams/verification/VerificationPathsDiagram"

import { PeopleTalkingDiagram } from "../diagrams/actors/PeopleTalkingDiagram"
import { ActorCommunicationDiagram } from "../diagrams/actors/ActorCommunicationDiagram"
import { ActorInstancesDiagram } from "../diagrams/actors/ActorInstancesDiagram"
import { ChildThreadsDiagram } from "../diagrams/actors/ChildThreadsDiagram"
import { ThreadInvocationDiagram } from "../diagrams/actors/ThreadInvocationDiagram"
import { ThreadResolutionDiagram } from "../diagrams/actors/ThreadResolutionDiagram"
import { BehaviorTrajectoryDiagram } from "../../notes/diagrams/BehaviorTrajectoryDiagram"
import { CompactionMachineDiagram } from "../../notes/diagrams/CompactionMachineDiagram"
import { HarnessDiagram } from "../../notes/diagrams/HarnessDiagram"
import { InterfaceComparisonDiagram } from "../../notes/diagrams/InterfaceComparisonDiagram"
import { RlmDiagram } from "../diagrams/RlmDiagram"
import { TrajectoryBranchesDiagram } from "../../notes/diagrams/TrajectoryBranchesDiagram"

import { Code, CodeFile, CodeFiles, Command, InlineCode } from "./Code"
import { Filesystem } from "./Filesystem"
import { Link, Math, Table, Tip } from "./elements"
import { InlineMine } from "./icons"

export const mdxComponents = {
  LibraryJigsaw,
  LibraryLayersDiagram,
  NotesList,
  AuthorAvatar, Dialogue, Socrates, You, AgentViewDiagram, CaveDiagram, FlyingTardie, MergeDiagram, RussianDollDiagram, ShadowDiagram,
  EventLogWorldDiagram,
  InstallCommand,
  CodePlayground,
  StorageLayoutDiagram,
  DurableAtomDiagram,
  DurableAtomFamilyDiagram,
  DurableAtomLogDiagram,
  EffectAtomDiagram,
  AtomSpreadsheet,
  StateInitialisationDiagram,
  StateSpaceSamplingDiagram,
  VerificationPathsDiagram,
  InlineMine,
  PaperclipProblemDiagram,
  FactoryToolsDiagram,
  ClippieToolsDiagram,
  FactoryPathGenerator,
  VerificationResultsDiagram,
  FactoryCounterexampleDiagram,
  FactoryDiversionDiagram,
  WorldObservationDiagram,
  CodeFiles,
  CodeFile,
  ActorInstancesDiagram,
  ActorCommunicationDiagram,
  PeopleTalkingDiagram,
  ChildThreadsDiagram,
  ThreadInvocationDiagram,
  AgentServicesDiagram,
  WorkspaceDeploymentDiagram,
  ThreadResolutionDiagram,
  BehaviorTrajectoryDiagram,
  Command,
  CompactionMachineDiagram,
  Filesystem,
  HarnessDiagram,
  InterfaceComparisonDiagram,
  Math,
  RlmDiagram,
  Tip,
  TrajectoryBranchesDiagram,
  a: Link,
  code: InlineCode,
  table: Table,
  pre: Code
}
