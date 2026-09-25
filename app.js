import { initializeApp } from "https://www.gstatic.com/firebasejs/12.3.0/firebase-app.js";
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/12.3.0/firebase-auth.js";
import { getFirestore, doc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.3.0/firebase-firestore.js";

// Replace these values with the Web App config from Firebase Project Settings.
const firebaseConfig = {
  apiKey: "AIzaSyDU9UzWb0tNicMOLZ6K01TGJ4-xrLEu-aQ",
  authDomain: "sendpilot-bf3b0.firebaseapp.com",
  projectId: "sendpilot-bf3b0",
  storageBucket: "sendpilot-bf3b0.firebasestorage.app",
  messagingSenderId: "711768959361",
  appId: "1:711768959361:web:35c6a722ae3fd40031a080",
  measurementId: "G-TX5KVCJ2TM"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const modal=document.querySelector("#authModal"), form=document.querySelector("#authForm"), title=document.querySelector("#authTitle"), subtitle=document.querySelector("#authSubtitle"), submit=document.querySelector("#authSubmit"), switchBtn=document.querySelector("#switchAuth"), status=document.querySelector("#authStatus");
let signup=true;
function openAuth(mode=true){signup=mode; title.textContent=signup?"Welcome to SendPilot":"Welcome back"; subtitle.textContent=signup?"Create your workspace to continue.":"Log in to your SendPilot workspace."; submit.textContent=signup?"Create account":"Log in"; switchBtn.textContent=signup?"Log in":"Create account"; status.textContent=""; modal.classList.remove("hidden")}
function closeAuth(){modal.classList.add("hidden");form.reset();status.textContent=""}
document.querySelector("#signupBtn").onclick=()=>openAuth(true); document.querySelector("#heroStart").onclick=()=>openAuth(true); document.querySelector("#loginBtn").onclick=()=>openAuth(false); document.querySelector("#heroLogin").onclick=()=>openAuth(false); document.querySelector("#closeModal").onclick=closeAuth; switchBtn.onclick=()=>openAuth(!signup);
form.addEventListener("submit",async e=>{e.preventDefault();status.textContent="";
 if(!configured){status.textContent="Firebase config अभी app.js में add करना है.";return}
 const email=document.querySelector("#email").value.trim(), password=document.querySelector("#password").value;
 try{
  const cred=signup?await createUserWithEmailAndPassword(auth,email,password):await signInWithEmailAndPassword(auth,email,password);
  if(signup) await setDoc(doc(db,"users",cred.user.uid),{name:email.split("@")[0],email,role:"user",status:"active",createdAt:serverTimestamp()},{merge:true});
  window.location.href="dashboard.html";
 }catch(err){status.textContent=err.code?.replace("auth/","").replaceAll("-"," ")||"Something went wrong";}
});