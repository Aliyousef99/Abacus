# The Abacus: System Architecture & Feature Breakdown

## Core Concept & Authentication

*   **Purpose**: The Abacus is a clandestine command-and-control system for the secret organization known as Talon. It serves as the central nervous system for intelligence analysis, agent management, and operational planning.
*   **The Facade**: To the outside world, the system presents a benign, uninteresting facade (e.g., a corporate intranet or a weather data service) to avoid suspicion.
*   **Secure Login**: Access is granted via a secure login portal. Authentication is handled by a robust system that issues JSON Web Tokens (JWTs). Upon successful login, the user is assigned a role (Protector, Heir, or Overlooker) which dictates their access level throughout the system.

## The Index

*   **Purpose**: The universal database of all individuals of interest within the city. It is the foundational dataset for all other system components.
*   **Key Features**:
    *   **Comprehensive Profiles**: Each entry contains a detailed profile with full name, aliases, classification (e.g., criminal, law enforcement, civilian), affiliations with factions, current status (active, deceased, etc.), and a calculated threat level.
    *   **Rich Data**: Profiles include a detailed biography, known strengths and weaknesses, locations, vehicles, and links to surveillance media.
    *   **Advanced Filtering**: The Index can be searched and filtered by any attribute, allowing for complex queries to identify individuals who meet specific criteria.
*   **Role-Based Permissions**:
    *   **Protector/HQ**: Full CRUD (Create, Read, Update, Delete) access.
    *   **Heir**: Full CRUD access.
    *   **Overlooker/Authenticated Users**: Can create and edit profiles, but cannot delete them.

## The Lineage

*   **Purpose**: To manage Talon's internal agents. This is a highly sensitive module that contains the identities and operational details of the organization's own personnel.
*   **Key Features**:
    *   **Agent Dossiers**: Each agent has a dossier with their alias, real name (highly classified), operational status, key skills, and psychological profile.
    *   **Soft Deletion**: Agents can be "archived" (soft-deleted) by Heirs, making them invisible to most users but recoverable by a Protector.
    *   **Reveal Protocol**: An agent's real name is a protected piece of information. A Protector can reveal it at will, but an Heir must provide a secondary authentication factor (a "secondary passphrase"). Overlookers cannot reveal real names.
    *   **Custom Ordering**: HQ can manually reorder the list of agents, likely to reflect seniority or operational priority.
*   **Role-Based Permissions**:
    *   **Protector/HQ**: Full CRUD access, including permanent deletion and the ability to reveal real names without secondary authentication.
    *   **Heir**: Can create, update, and archive agents. Can reveal real names with secondary authentication.
    *   **Overlooker**: Read-only access. Cannot reveal real names or view archived agents.

## The Scales

*   **Purpose**: To track the various factions operating within the city, their members, and the organization's leverage over them.
*   **Key Features**:
    *   **Faction Profiles**: Each faction has a profile with its name, threat index, description, allies, and known strengths and weaknesses.
    *   **Member Tracking**: The system links individuals from The Index to factions, building a comprehensive picture of each group's membership.
    
    *   **Network Analysis**: A powerful feature that visualizes the relationships between factions, their members, and Talon's own agents, creating a network graph of the city's underworld.
*   **Role-Based Permissions**:
    *   **Protector/HQ**: Full CRUD access.
    *   **Heir**: Full CRUD access.
    *   **Overlooker**: Read-only access.

## The Silo

*   **Purpose**: A secure pipeline for intelligence reporting. Overlookers can submit raw intelligence, which is then reviewed and actioned by leadership.
*   **Key Features**:
    *   **Echo Submission**: Overlookers and other users can submit "Echoes" – raw intelligence reports with a title, content, confidence level, and supporting evidence.
    *   **Leadership Review**: Protectors and Heirs can review submitted Echoes. They can dismiss them, promote them for further action, or assign them to specific Lineage agents for investigation.
    *   **Secure Comments**: Protectors and Heirs can have secure discussions on each Echo through a commenting system.
*   **Role-Based Permissions**:
    *   **Protector/Heir**: Can review, comment on, and manage all Echoes.
    *   **Overlooker/Authenticated Users**: Can submit Echoes and view the status of their own submissions.

## The Loom

*   **Purpose**: To manage the entire lifecycle of an operation, from initial planning to after-action review.
*   **Key Features**:
    *   **Operation Planning**: Protectors and Heirs can create new operations, defining their codename, objectives, and initial risk assessment.
    *   **Resource Allocation**: The Loom integrates with The Vault to allow for the requisition and allocation of assets (vehicles, properties, financial instruments) to an operation.
    *   **Personnel Assignment**: Lineage agents can be assigned to an operation.
    *   **Lifecycle Management**: Operations move through a defined lifecycle (Planning -> Active -> Concluded/Compromised). A Protector is required to "commence" an operation.
    *   **Operation Logs**: A real-time log of all significant events during an active operation.
*   **Role-Based Permissions**:
    *   **Protector**: Full control over all aspects of an operation, including the ability to commence and delete them.
    *   **Heir**: Can plan and manage operations, but cannot commence or delete them.
    *   **Overlooker**: Read-only access to non-sensitive operational data.

## The Pulse

*   **Purpose**: The main dashboard of The Abacus, providing a real-time overview of the city and the organization's activities.
*   **Key Features (Inferred)**:
    *   **Threat Assessment Widget**: A high-level summary of the overall threat environment, based on data from The Scales.
    *   **Active Operations**: A list of all currently active operations from The Loom.
    *   **Intelligence Feed**: A stream of the latest high-priority intelligence from The Silo.
    *   **Agent Status**: A summary of the status of all Lineage agents.
    *   **City-Wide Map**: A geographical visualization of faction territories, agent locations, and active operations.

## The Codex

*   **Purpose**: The central knowledge base of the organization, containing everything from historical records to standard operating procedures.
*   **Key Features**:
    *   **Widget-Based UI**: The Codex is presented through a widget-based UI, with categories like "Historic Events," "Doctrine & Philosophy," and "Threat Analysis Reports."
    *   **Rich Content**: Entries can include text, images, and links to other parts of the system.
    *   **Protector's Annotations (Inferred)**: A special feature allowing the Protector to add their own private annotations to any Codex entry, visible only to them and their Heir.
    *   **Scenario Simulator (Inferred)**: A tool that uses the data from The Index, Scales, and Lineage to run simulations of potential operations, allowing for strategic planning and risk assessment.
*   **Role-Based Permissions**:
    *   **Protector/HQ**: Full CRUD access to all Codex entries.
    *   **Heir**: Read-only access, but can view Protector's Annotations.
    *   **Overlooker**: Read-only access.

## The Vault

*   **Purpose**: To manage the organization's physical and financial assets.
*   **Key Features**:
    *   **Asset Management**: The Vault tracks shell corporations, untraceable bank accounts, cryptocurrency wallets, physical properties (safehouses, warehouses), and vehicles.
    *   **Secure Access**: Access to The Vault is highly restricted. Heirs require secondary authentication to view and manage assets.
*   **Role-Based Permissions**:
    *   **Protector/HQ**: Full access.
    *   **Heir**: Can access with secondary authentication.
    *   **Overlooker**: No access.

## Advanced Security Features

*   **Ghost Protocol (Duress Login)**: A duress login feature. If a user logs in with a special "ghost" password, the system appears to function normally, but it immediately triggers a silent alert to the Protector and can be configured to take other actions, such as locking down certain features or wiping sensitive data. This is implemented via the `panic` functionality in the `users` app.
*   **Audit Trail**: An immutable, system-wide audit trail that logs every significant action taken by every user. This is crucial for security, accountability, and after-action reviews. The audit log is only accessible to the Protector and HQ.
